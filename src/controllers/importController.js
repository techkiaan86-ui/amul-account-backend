const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const XLSX = require('xlsx');

function parseCSV(csvText) {
  const lines = [];
  let currentVal = '';
  let inQuotes = false;
  let currentLine = [];

  // Handle potential byte order mark (BOM)
  if (csvText.charCodeAt(0) === 0xFEFF) {
    csvText = csvText.slice(1);
  }

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentVal += '"';
          i++; // Skip the next quote
        } else {
          inQuotes = false;
        }
      } else {
        currentVal += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentLine.push(currentVal.trim());
        currentVal = '';
      } else if (char === '\n' || char === '\r') {
        currentLine.push(currentVal.trim());
        lines.push(currentLine);
        currentLine = [];
        currentVal = '';
        if (char === '\r' && nextChar === '\n') {
          i++; // Skip the \n in \r\n
        }
      } else {
        currentVal += char;
      }
    }
  }

  if (currentVal !== '' || currentLine.length > 0) {
    currentLine.push(currentVal.trim());
    lines.push(currentLine);
  }

  if (lines.length === 0) return [];

  const headers = lines[0].map(h => h.trim());
  const results = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const isEmptyLine = line.length === 0 || (line.length === 1 && line[0] === '');
    if (isEmptyLine) continue;

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = line[j] !== undefined ? line[j] : '';
    }
    results.push(row);
  }

  return results;
}

const parsePrice = (value) => {
  if (value === undefined || value === null) return 0;
  const cleanVal = String(value).replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleanVal);
  return isNaN(parsed) ? 0 : parsed;
};

exports.handleGeneralImport = async (req, res) => {
  try {
    const companyId = req.user.companyId;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded or file exceeds 5MB limit.' });
    }

    let { selectedTypes } = req.body;
    if (typeof selectedTypes === 'string') {
      try {
        selectedTypes = JSON.parse(selectedTypes);
      } catch (e) {
        selectedTypes = selectedTypes.split(',');
      }
    }

    if (!selectedTypes || selectedTypes.length === 0) {
      return res.status(400).json({ success: false, message: 'Please select at least one import type.' });
    }

    let results = [];
    const fileExtension = req.file.originalname ? req.file.originalname.split('.').pop().toLowerCase() : '';

    if (fileExtension === 'xlsx' || fileExtension === 'xls') {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      results = XLSX.utils.sheet_to_json(sheet);
    } else {
      const csvText = req.file.buffer.toString('utf-8');
      results = parseCSV(csvText);
    }
    let importedCount = 0;

    try {
      if (selectedTypes.includes('Master')) {
        const customersToInsert = results.filter(r => r.name || r.Name).map(r => ({
          name: r.name || r.Name,
          phone: r.phone || r.Phone || null,
          companyId
        }));

        if (customersToInsert.length > 0) {
          for (const customerData of customersToInsert) {
            const existing = await prisma.customer.findFirst({
              where: {
                name: customerData.name,
                companyId: customerData.companyId
              }
            });
            
            if (existing) {
              await prisma.customer.update({
                where: { id: existing.id },
                data: customerData
              });
            } else {
              await prisma.customer.create({
                data: customerData
              });
            }
          }
          importedCount += customersToInsert.length;
        }
      }

      if (selectedTypes.includes('Product Master')) {
        const productsToInsert = results.filter(r => (r["Item Name"] || r.name || r.Name) && (r.SKU || r.sku || r.SKU)).map(r => {
          const variantsVal = String(r["Variants/IMEI"] || "").trim();
          const enableImei = variantsVal !== "" && variantsVal !== "-";

          const isBomVal = String(r["Is BOM"] || "").trim().toLowerCase();
          const hasBom = isBomVal === "yes" || isBomVal === "true";

          return {
            name: r["Item Name"] || r.name || r.Name,
            sku: String(r.SKU || r.sku || ""),
            barcode: r.Barcode || r.barcode ? String(r.Barcode || r.barcode) : null,
            category: r.Category || r.category || null,
            brand: r.Brand || r.brand || null,
            mrp: parsePrice(r.MRP || r.mrp),
            price: parsePrice(r["Sale Price"] || r.price),
            purchasePrice: parsePrice(r["Purchase Price"] || r.purchasePrice),
            stock: parseInt(String(r.Stock || r.stock || 0).replace(/[^0-9]/g, '')) || 0,
            enableImei: enableImei,
            hasBom: hasBom,
            companyId
          };
        });

        if (productsToInsert.length > 0) {
          await prisma.$transaction(
            productsToInsert.map(productData => 
              prisma.product.upsert({
                where: {
                  sku_companyId: {
                    sku: productData.sku,
                    companyId: productData.companyId
                  }
                },
                update: productData,
                create: productData
              })
            )
          );
          importedCount += productsToInsert.length;
        }
      }

      res.json({
        success: true,
        message: `Successfully processed file.`,
        importedCount
      });

    } catch (dbError) {
      console.error("DB Error in import:", dbError);
      res.status(500).json({ success: false, message: 'Database error during import.', error: dbError.message });
    }

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error during import.' });
  }
};

const { GoogleGenerativeAI } = require('@google/generative-ai');

exports.handleAIInvoiceImport = async (req, res) => {
  try {
    const companyId = req.user.companyId;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded or file exceeds 5MB limit.' });
    }

    const apiKey = req.body.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, message: 'AI API key is missing. Please provide it in the UI or .env' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });

    // Prepare file data
    let mimeType = req.file.mimetype;
    let fileData = req.file.buffer.toString("base64");

    let prompt = `
Extract the following information from the provided purchase invoice image/pdf.
Return ONLY a strictly formatted JSON object following this exact schema without any markdown blocks or additional text:
{
  "supplierName": "String",
  "supplierGstin": "String",
  "invoiceNumber": "String",
  "invoiceDate": "YYYY-MM-DD",
  "items": [
    {
      "productName": "String",
      "hsnCode": "String",
      "batchNo": "String",
      "quantity": 10,
      "unit": "String",
      "purchasePrice": 150.00,
      "discountPercent": 0,
      "taxPercent": 18,
      "cgst": 9,
      "sgst": 9,
      "igst": 0,
      "amount": 1500.00
    }
  ],
  "subtotal": 1500.00,
  "totalTax": 270.00,
  "grandTotal": 1770.00
}
Ensure numeric values are numbers, not strings. For missing values, use null or 0.
`;

    if (req.body.instructions && req.body.instructions.trim() !== '') {
      prompt += `\nAdditional Instructions from User: ${req.body.instructions.trim()}\n`;
    }

    const result = await model.generateContent([
      {
        inlineData: {
          data: fileData,
          mimeType: mimeType
        }
      },
      prompt
    ]);

    const responseText = result.response.text();
    const cleanJsonText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    let extractedData;
    try {
      extractedData = JSON.parse(cleanJsonText);
    } catch (parseError) {
      console.error("AI returned invalid JSON:", responseText);
      return res.status(500).json({ success: false, message: 'AI failed to extract structured data. Please try again or manually enter.' });
    }

    // Smart Entity Matching
    let matchedSupplierId = null;
    if (extractedData.supplierName || extractedData.supplierGstin) {
      const supplierConditions = [];
      if (extractedData.supplierName) supplierConditions.push({ name: { contains: extractedData.supplierName } });
      if (extractedData.supplierGstin) supplierConditions.push({ gstin: extractedData.supplierGstin });

      const supplier = await prisma.customer.findFirst({
        where: {
          companyId,
          OR: supplierConditions
        }
      });
      if (supplier) {
        matchedSupplierId = supplier.id;
        extractedData.supplierName = supplier.name; // Use system name
      }
    }

    const itemsWithProductMatch = [];
    if (Array.isArray(extractedData.items)) {
      for (const item of extractedData.items) {
        let matchedProductId = null;
        if (item.productName) {
          const product = await prisma.product.findFirst({
            where: {
              companyId,
              name: { contains: item.productName }
            }
          });
          if (product) {
            matchedProductId = product.id;
            item.productName = product.name; // Standardize name
          }
        }
        itemsWithProductMatch.push({
          ...item,
          matchedProductId
        });
      }
    }

    extractedData.items = itemsWithProductMatch;

    return res.json({
      success: true,
      data: {
        ...extractedData,
        matchedSupplierId
      }
    });

  } catch (error) {
    console.error("AI Invoice Import Error:", error);
    res.status(500).json({ success: false, message: 'An error occurred during AI processing.' });
  }
};