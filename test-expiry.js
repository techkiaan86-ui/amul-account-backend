const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const prods = await prisma.product.findMany({ select: { name: true, expiryMonth: true } });
  console.log('Products:', prods.filter(p => p.expiryMonth && p.expiryMonth !== '0'));
  
  const items = await prisma.invoiceItem.findMany({ 
    where: { expDate: { not: null, not: '' } },
    select: { id: true, expDate: true, product: { select: { name: true } } }
  });
  console.log('Items:', items);
}
main().finally(() => prisma.$disconnect());
