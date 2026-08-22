const express = require('express');
const router = express.Router();
const multer = require('multer');
const { verifyToken, requireRole } = require('../middlewares/authMiddleware');
const { handleGeneralImport, handleAIInvoiceImport } = require('../controllers/importController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

router.use(verifyToken);

router.post('/general', requireRole(['COMPANY_ADMIN', 'SUPERADMIN']), upload.single('file'), handleGeneralImport);
router.post('/ai-invoice', requireRole(['COMPANY_ADMIN', 'SUPERADMIN', 'STAFF']), upload.single('file'), handleAIInvoiceImport);

module.exports = router;
