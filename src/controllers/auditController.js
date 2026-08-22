const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// GET /api/v1/audit-logs - tenant scoped audit log
exports.getLogs = async (req, res) => {
  const companyId = req.user.companyId;
  const role = req.user.role;

  if (!companyId && role !== 'SUPERADMIN') {
    return res.status(400).json({ success: false, message: 'Company ID is required' });
  }

  try {
    const whereClause = companyId ? { companyId } : {};
    const logs = await prisma.auditLog.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
    });
    
    // Map data to match what the frontend expects
    const formattedLogs = logs.map(log => {
      let parsedDetails = {};
      try {
        if (log.details && typeof log.details === 'string') {
          parsedDetails = JSON.parse(log.details);
        } else if (log.details && typeof log.details === 'object') {
          parsedDetails = log.details;
        }
      } catch (e) {
        // details might just be a regular string, which is fine
      }
      
      // Fallback to updatedData / previousData if used
      const parsedUpdatedData = log.updatedData || {};
      const parsedPreviousData = log.previousData || {};

      return {
        ...log,
        timestamp: log.createdAt,
        userName: log.userName || 'System',
        billNumber: log.billNumber || parsedDetails.documentNumber || '-',
        partyName: parsedDetails.partyName || parsedUpdatedData.partyName || '-',
        amount: parsedDetails.amount ?? parsedUpdatedData.amount ?? null,
        previousAmount: parsedDetails.previousAmount ?? parsedPreviousData.amount ?? null,
      };
    });
    
    res.status(200).json({ success: true, data: formattedLogs });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /api/v1/audit-logs - create a new audit log
exports.createLog = async (req, res) => {
  const companyId = req.user.companyId;
  const userName = req.user.name || req.user.email || req.user.username || String(req.user.id) || 'Unknown User';
  const userRole = req.user.role || 'User';

  const {
    actionType,
    billNumber,
    moduleName,
    previousData,
    updatedData,
    ipAddress,
    details,
    referenceId
  } = req.body;

  if (!actionType) {
    return res.status(400).json({ success: false, message: 'actionType is required' });
  }

  try {
    const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : (req.ip || req.socket.remoteAddress);

    const newLog = await prisma.auditLog.create({
      data: {
        actionType,
        details: details || null,
        referenceId: referenceId ? String(referenceId) : null,
        userName,
        userRole,
        billNumber: billNumber ? String(billNumber) : null,
        moduleName: moduleName || null,
        previousData: previousData || null,
        updatedData: updatedData || null,
        ipAddress: clientIp || null,
        companyId
      }
    });

    res.status(201).json({ success: true, data: newLog });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error while creating audit log' });
  }
};
