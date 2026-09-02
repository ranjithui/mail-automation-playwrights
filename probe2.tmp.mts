import { GmailAutomationService } from '@mail/playwright';
import { prisma } from '@mail/database';

const acct = await prisma.emailAccount.findFirstOrThrow({ where: { status: 'ACTIVE' } });
const driver: any = new GmailAutomationService({ accountId: acct.id, email: acct.email, displayName: acct.displayName });
await driver.connect();
const page = (driver as any).page;

const ids: string[] = await page.evaluate(() => {
  const out: string[] = [];
  const doc = (globalThis as any).document;
  for (const row of Array.from(doc.querySelectorAll('tr.zA')).slice(0, 3) as any[]) {
    const h = row.querySelector('[data-legacy-thread-id], [data-thread-id]');
    const id = h?.getAttribute('data-legacy-thread-id') || h?.getAttribute('data-thread-id')?.replace(/^#/, '') || row.getAttribute('id');
    if (id) out.push(String(id));
  }
  return out;
});
console.log('ids:', ids);

await page.evaluate((h: string) => { (globalThis as any).location.hash = h; }, `#all/${ids[0]}`);
await new Promise((r) => setTimeout(r, 5000));
console.log('url:', page.url());

// No inner function declarations - esbuild injects __name into those and the
// page has no such helper.
const probe = await page.evaluate(() => {
  const doc = (globalThis as any).document;
  return {
    threadPermId: doc.querySelectorAll('div[data-thread-perm-id]').length,
    threadPermIdInMain: doc.querySelectorAll('div[role="main"] div[data-thread-perm-id]').length,
    legacyThreadId: doc.querySelectorAll('[data-legacy-thread-id]').length,
    messageId: doc.querySelectorAll('div[data-message-id]').length,
    adnAds: doc.querySelectorAll('div.adn.ads').length,
    bodyA3s: doc.querySelectorAll('div.a3s').length,
    subjectH2: doc.querySelectorAll('h2.hP').length,
    spanEmail: doc.querySelectorAll('span[email]').length,
    listRows: doc.querySelectorAll('tr.zA').length,
    nHif: doc.querySelectorAll('div.nH.if').length,
    subject: (doc.querySelector('h2.hP') || {}).textContent || null,
  };
});
console.log('\nselector counts on the opened thread:');
for (const k of Object.keys(probe)) console.log(`  ${k.padEnd(22)} ${(probe as any)[k]}`);

await driver.close();
await prisma.$disconnect();
