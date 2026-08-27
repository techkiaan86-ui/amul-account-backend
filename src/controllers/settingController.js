const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const bcrypt = require('bcryptjs');

// Get settings for the current user's company
exports.getSettings = async (req, res) => {
  try {
    const companyId = req.user.companyId;

    if (!companyId) {
      return res.status(200).json({ 
        success: true, 
        data: {
          printHeader: null,
          printFooter: null,
          showLogo: true,
          paperSize: 'A4',
          fontSize: 'medium',
          currency: 'INR',
          dateFormat: 'DD-MM-YYYY',
        }
      });
    }

    let settings = await prisma.companySetting.findUnique({
      where: { companyId }
    });

    // If no settings exist yet, return a safe default object without trying to create
    if (!settings) {
      settings = {
        companyId,
        printHeader: null,
        printFooter: null,
        showLogo: true,
        paperSize: 'A4',
        fontSize: 'medium',
        currency: 'INR',
        dateFormat: 'DD-MM-YYYY',
      };
    }

    res.status(200).json({ success: true, data: settings });
  } catch (error) {
    console.error("Error fetching settings:", error);
    res.status(500).json({ success: false, error: "Failed to fetch settings" });
  }
};

// Update settings
exports.updateSettings = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    if (!companyId) {
      return res.status(400).json({ success: false, error: "No company associated with this user" });
    }
    const updates = req.body;

    // Optional: Filter out properties that are not allowed to be updated directly
    delete updates.id;
    delete updates.companyId;
    delete updates.showIMEI; // Not in Prisma schema
    delete updates.showFreeQty; // Not in Prisma schema
    delete updates.manageVariants; // Not in Prisma schema
    delete updates.showSKU; // Not in Prisma schema
    delete updates.showVariantsImei; // Not in Prisma schema
    delete updates.quantityCalculator; // Not in Prisma schema

    const updatedSettings = await prisma.companySetting.upsert({
      where: { companyId },
      update: updates,
      create: {
        companyId,
        ...updates
      }
    });

    res.status(200).json({ success: true, data: updatedSettings });
  } catch (error) {
    console.error("Error updating settings:", error);
    res.status(500).json({ success: false, error: "Failed to update settings" });
  }
};

// Reset database for company
exports.resetDatabase = async (req, res) => {
  try {
    const { password, deleteMasterData } = req.body;
    const companyId = req.user.companyId;

    if (!companyId) {
      return res.status(400).json({ success: false, message: 'No company associated with this user' });
    }

    // Verify admin password
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.role !== 'SUPERADMIN' && user.role !== 'COMPANY_ADMIN') {
      return res.status(403).json({ success: false, message: 'Not authorized to reset database' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Incorrect password' });
    }

    // Execute atomic cascade transactional wipeout
    await prisma.$transaction(async (tx) => {
      // 1. Loading Sheets
      await tx.loadingSheetItem.deleteMany({ where: { loadingSheet: { companyId } } });
      await tx.loadingSheet.deleteMany({ where: { companyId } });

      // 2. Invoices & Items (Sales, Purchases, Quotations, Orders, Returns, Challans)
      await tx.invoiceItem.deleteMany({ where: { invoice: { companyId } } });
      await tx.invoice.deleteMany({ where: { companyId } });

      // 3. Customer Payments & Followups
      await tx.customerPayment.deleteMany({ where: { companyId } });
      await tx.followup.deleteMany({ where: { customer: { companyId } } });

      // 4. Vouchers & BOMs
      await tx.voucher.deleteMany({ where: { companyId } });
      await tx.bomItem.deleteMany({ where: { bom: { companyId } } });
      await tx.bom.deleteMany({ where: { companyId } });

      // 5. Stock logs & Warehouse stock records
      await tx.stockAdjustmentLog.deleteMany({ where: { companyId } });
      await tx.warehouseStock.deleteMany({ where: { companyId } });

      // 6. Employees transactions & Attendances
      await tx.attendance.deleteMany({ where: { companyId } });
      await tx.employeeTransaction.deleteMany({ where: { companyId } });

      // 7. Expenses & Incomes transactions
      await tx.expenseTransaction.deleteMany({ where: { companyId } });
      await tx.incomeTransaction.deleteMany({ where: { companyId } });

      // 8. Bank transactions, statements, cash books & payment books transactions
      await tx.bankStatementRecord.deleteMany({ where: { companyId } });
      await tx.bankStatement.deleteMany({ where: { companyId } });
      await tx.bankTransaction.deleteMany({ where: { companyId } });
      await tx.paymentBookTransaction.deleteMany({ where: { companyId } });
      await tx.cashBook.deleteMany({ where: { companyId } });

      // 9. Audit Logs, Complaints, Service Reminders, Offers, Messages
      await tx.auditLog.deleteMany({ where: { companyId } });
      await tx.complaint.deleteMany({ where: { companyId } });
      await tx.serviceReminder.deleteMany({ where: { companyId } });
      await tx.offer.deleteMany({ where: { companyId } });
      await tx.messageTemplate.deleteMany({ where: { companyId } });

      // 10. Attribute values & unit mappings
      await tx.productAttributeValue.deleteMany({ where: { product: { companyId } } });
      await tx.categoryUnit.deleteMany({ where: { category: { companyId } } });
      await tx.categoryAttribute.deleteMany({ where: { category: { companyId } } });
      await tx.unitConversion.deleteMany({ where: { companyId } });
      await tx.partyTag.deleteMany({ where: { companyId } });
      await tx.productTag.deleteMany({ where: { companyId } });
      await tx.commissionType.deleteMany({ where: { companyId } });

      // 11. Master Data handling
      if (deleteMasterData) {
        await tx.product.deleteMany({ where: { companyId } });
        await tx.customer.deleteMany({ where: { companyId } });
        await tx.employee.deleteMany({ where: { companyId } });
        await tx.bank.deleteMany({ where: { companyId } });
        await tx.paymentBook.deleteMany({ where: { companyId } });
        await tx.warehouse.deleteMany({ where: { companyId } });
        await tx.location.deleteMany({ where: { companyId } });
        await tx.branch.deleteMany({ where: { companyId } });
        await tx.category.deleteMany({ where: { companyId } });
        await tx.unit.deleteMany({ where: { companyId } });
        await tx.expense.deleteMany({ where: { companyId } });
        await tx.income.deleteMany({ where: { companyId } });
        await tx.barcodeTemplate.deleteMany({ where: { companyId } });
      } else {
        // Reset balances and stock counts to zero for clean dashboards & accounts
        await tx.product.updateMany({
          where: { companyId },
          data: { stock: 0 }
        });
        await tx.customer.updateMany({
          where: { companyId },
          data: { balance: 0, loyaltyPoints: 0 }
        });
        await tx.bank.updateMany({
          where: { companyId },
          data: { balance: 0 }
        });
        await tx.employee.updateMany({
          where: { companyId },
          data: { balance: 0, commission: 0, specialCommission: 0, totalSaleCommission: 0, commissionOnManufacturing: 0 }
        });
        await tx.expense.updateMany({
          where: { companyId },
          data: { balance: 0 }
        });
        await tx.income.updateMany({
          where: { companyId },
          data: { balance: 0 }
        });
      }
    });

    res.status(200).json({ success: true, message: 'Database reset successfully' });
  } catch (error) {
    console.error('Reset database error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error during database reset' });
  }
};
