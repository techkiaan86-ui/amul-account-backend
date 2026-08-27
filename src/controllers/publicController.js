const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Public: Get invoice by invoiceNo (no auth required)
exports.getPublicBill = async (req, res) => {
  const { invoiceNo } = req.params;

  try {
    const invoice = await prisma.invoice.findFirst({
      where: { invoiceNo: invoiceNo },
      include: {
        customer: true,
        items: {
          include: {
            product: true
          }
        },
        company: {
          include: {
            companySetting: true
          }
        }
      }
    });

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Bill not found' });
    }

    const invoiceData = {
      ...invoice,
      company: invoice.company ? {
        ...invoice.company,
        email: invoice.company.ownerEmail
      } : null
    };

    res.status(200).json({ success: true, data: invoiceData });
  } catch (error) {
    console.error('getPublicBill error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// Public: Get product by identifier (id, barcode, or sku) (no auth required)
exports.getPublicProduct = async (req, res) => {
  const { identifier } = req.params;

  try {
    if (!identifier) {
      return res.status(400).json({ success: false, message: 'Product identifier is required' });
    }

    const isNumeric = !isNaN(identifier) && !isNaN(parseInt(identifier, 10));
    const numericId = isNumeric ? parseInt(identifier, 10) : null;

    const whereConditions = [
      { barcode: identifier },
      { sku: identifier }
    ];

    if (numericId !== null) {
      whereConditions.push({ id: numericId });
    }

    const product = await prisma.product.findFirst({
      where: {
        OR: whereConditions,
        deletedAt: null
      },
      include: {
        company: {
          select: {
            name: true,
            phone: true,
            address: true,
            logo: true,
            ownerEmail: true,
            status: true
          }
        }
      }
    });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Public safe data (exclude internal purchase secrets if needed, but provide MRP, sale prices, units, HSN, specs)
    const publicData = {
      id: product.id,
      name: product.name,
      hindiName: product.hindiName,
      sku: product.sku,
      barcode: product.barcode,
      mrp: product.mrp,
      price: product.price,
      wholesalePrice: product.wholesalePrice,
      category: product.category,
      brand: product.brand,
      size: product.size,
      colour: product.colour || product.colorVariant,
      tax: product.tax,
      hsnCode: product.hsnCode,
      baseUnit: product.baseUnit,
      salesUnit: product.salesUnit,
      purchaseUnit: product.purchaseUnit,
      productImage: product.productImage,
      description: product.description,
      location: product.location,
      status: product.status,
      stock: product.stock,
      company: product.company
    };

    res.status(200).json({ success: true, data: publicData });
  } catch (error) {
    console.error('getPublicProduct error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// Public: Get all subscription plans
exports.getPublicPlans = async (req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      include: {
        _count: {
          select: { companies: true }
        }
      }
    });
    res.status(200).json({ success: true, data: plans });
  } catch (error) {
    console.error('getPublicPlans error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

