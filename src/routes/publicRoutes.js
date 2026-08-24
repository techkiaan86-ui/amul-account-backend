const express = require('express');
const router = express.Router();
const { getPublicBill, getPublicPlans, getPublicProduct } = require('../controllers/publicController');

// No auth required — public access
router.get('/bill/:invoiceNo', getPublicBill);
router.get('/product/:identifier', getPublicProduct);
router.get('/plans', getPublicPlans);

module.exports = router;
