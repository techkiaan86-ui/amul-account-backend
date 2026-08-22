const express = require('express');
const router = express.Router();
const { 
  getVouchers, 
  updateVoucher,
  getNextNumberPreview,
  fixVoucherSeriesRange
} = require('../controllers/voucherController');
const { verifyToken } = require('../middlewares/authMiddleware');

router.use(verifyToken);

router.get('/next-number', getNextNumberPreview);
router.get('/', getVouchers);
router.put('/:id', updateVoucher);
router.post('/fix-series', fixVoucherSeriesRange);

module.exports = router;
