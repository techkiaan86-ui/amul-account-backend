const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DEFAULT_TEMPLATES = [
  {
    name: '50mm X 25mm',
    pageWidth: '50mm',
    pageHeight: '25mm',
    labelsInRow: '2',
    pageBreak: 'YES',
    leftMargin: '0.5',
    rightMargin: '0.5',
    labelGap: '1mm',
    heightGap: '1mm',
    grnNumber: false,
    showBrand: false,
    showMRP: true,
    showAdditionalInfo: false,
    showSalePrice: true,
    showWholeSalePrice: false,
    doubleMRP: false,
    crossMRP: false,
    showBorder: true,
    showCategory: false,
    showLocation: false,
    showUnit: true,
    showMultiLine: false,
    showSpecialCommission: false,
    showHeading: true,
    hideBarcode: false,
    showDiscount: false,
    showSize: false,
    showColor: false,
    showImei: false,
    showBatchNo: false,
    barcodeHeading: 'SWAYAM BILL',
    headingFontSize: '9px',
    productFontSize: '11px',
    footerFontSize: '8px',
    salePriceFontSize: '9px',
    mrpFontSize: '9px',
    discountFontSize: '9px',
    barcodeWidth: '1.2',
    barcodeHeight: '28',
    marginTop: '0mm',
    marginBottom: '0mm',
    marginLeft: '0mm',
    marginRight: '0mm',
    registerOfficeAddress: 'Hint - Multiple Address Lines',
    terms: 'Add Terms',
    barcodeFormat: 'Format 4'
  }
];

// Get all barcode templates for the company
exports.getBarcodeSettings = async (req, res) => {
  const companyId = req.user.companyId;
  try {
    let templates = await prisma.barcodeTemplate.findMany({
      where: { companyId },
      orderBy: { id: 'asc' }
    });

    if (templates.length === 0) {
      const created = await prisma.barcodeTemplate.create({
        data: {
          ...DEFAULT_TEMPLATES[0],
          companyId
        }
      });
      templates = [created];
    }

    res.status(200).json({ success: true, data: templates });
  } catch (error) {
    console.error('Error in getBarcodeSettings:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Create a new barcode template
exports.createBarcodeSetting = async (req, res) => {
  const companyId = req.user.companyId;
  const data = req.body || {};
  const name = (data.name || data.pageType || '').trim();
  if (!name) {
    return res.status(400).json({ success: false, message: 'Template name is required' });
  }

  const allowedFields = [
    'name', 'pageWidth', 'pageHeight', 'labelsInRow', 'pageBreak', 'leftMargin', 'rightMargin',
    'labelGap', 'heightGap', 'grnNumber', 'showBrand', 'showMRP', 'showAdditionalInfo',
    'showSalePrice', 'showWholeSalePrice', 'doubleMRP', 'crossMRP', 'showBorder',
    'showCategory', 'showLocation', 'showUnit', 'showMultiLine', 'showSpecialCommission',
    'showHeading', 'hideBarcode', 'showDiscount', 'showSize', 'showColor', 'showImei',
    'showBatchNo', 'barcodeHeading', 'headingFontSize', 'productFontSize', 'footerFontSize',
    'salePriceFontSize', 'mrpFontSize', 'discountFontSize', 'barcodeWidth', 'barcodeHeight',
    'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'registerOfficeAddress',
    'terms', 'barcodeFormat', 'elements'
  ];

  const createData = { name, companyId };
  for (const field of allowedFields) {
    if (field !== 'name' && data[field] !== undefined) {
      createData[field] = data[field];
    }
  }

  try {
    const template = await prisma.barcodeTemplate.create({
      data: createData
    });
    res.status(201).json({ success: true, data: template });
  } catch (error) {
    console.error('Error in createBarcodeSetting:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Update an existing barcode template
exports.updateBarcodeSetting = async (req, res) => {
  const companyId = req.user.companyId;
  const { id } = req.params;
  const body = req.body || {};

  const allowedFields = [
    'name', 'pageWidth', 'pageHeight', 'labelsInRow', 'pageBreak', 'leftMargin', 'rightMargin',
    'labelGap', 'heightGap', 'grnNumber', 'showBrand', 'showMRP', 'showAdditionalInfo',
    'showSalePrice', 'showWholeSalePrice', 'doubleMRP', 'crossMRP', 'showBorder',
    'showCategory', 'showLocation', 'showUnit', 'showMultiLine', 'showSpecialCommission',
    'showHeading', 'hideBarcode', 'showDiscount', 'showSize', 'showColor', 'showImei',
    'showBatchNo', 'barcodeHeading', 'headingFontSize', 'productFontSize', 'footerFontSize',
    'salePriceFontSize', 'mrpFontSize', 'discountFontSize', 'barcodeWidth', 'barcodeHeight',
    'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'registerOfficeAddress',
    'terms', 'barcodeFormat', 'elements'
  ];

  const updateData = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updateData[field] = body[field];
    }
  }

  if (body.pageType && !updateData.name) {
    updateData.name = body.pageType;
  }

  try {
    const template = await prisma.barcodeTemplate.update({
      where: { id: parseInt(id, 10), companyId },
      data: updateData
    });
    res.status(200).json({ success: true, data: template });
  } catch (error) {
    console.error('Error in updateBarcodeSetting:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Delete a barcode template
exports.deleteBarcodeSetting = async (req, res) => {
  const companyId = req.user.companyId;
  const { id } = req.params;
  try {
    await prisma.barcodeTemplate.delete({
      where: { id: parseInt(id, 10), companyId }
    });
    res.status(200).json({ success: true, message: 'Barcode template deleted successfully' });
  } catch (error) {
    console.error('Error in deleteBarcodeSetting:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
