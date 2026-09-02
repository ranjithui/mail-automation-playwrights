/**
 * Seeds a demo tenant so the platform is usable the moment it boots:
 * an organization, five users covering every role, three mailboxes, templates,
 * a contact list with realistic prospects and a four-step campaign.
 *
 * Re-running is safe: everything is upserted by natural key.
 */
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { env } from '@mail/config';
import { stringifyJson } from '@mail/shared';

const prisma = new PrismaClient();

const OWNER_EMAIL = env.SEED_OWNER_EMAIL;
const OWNER_PASSWORD = env.SEED_OWNER_PASSWORD;

const TEAM = [
  { email: OWNER_EMAIL, firstName: 'Alex', lastName: 'Morgan', role: 'OWNER' },
  { email: 'admin.user@mailflow.local', firstName: 'Priya', lastName: 'Nair', role: 'ADMIN' },
  { email: 'manager@mailflow.local', firstName: 'Daniel', lastName: 'Okafor', role: 'MANAGER' },
  { email: 'user@mailflow.local', firstName: 'Sofia', lastName: 'Rossi', role: 'USER' },
  { email: 'viewer@mailflow.local', firstName: 'Kenji', lastName: 'Watanabe', role: 'VIEWER' },
];

const MAILBOXES = [
  { email: 'sales@company.com', displayName: 'Alex Morgan | Sales', dailyLimit: 200 },
  { email: 'marketing@company.com', displayName: 'Marketing Team', dailyLimit: 150 },
  { email: 'support@company.com', displayName: 'Customer Success', dailyLimit: 100 },
];

const TEMPLATES = [
  {
    name: 'Initial outreach',
    category: 'OUTREACH',
    subject: 'Quick question about {{Company Name}}',
    bodyHtml: `<p>Hi {{First Name | there}},</p>
<p>I noticed {{Company Name}} is working in {{Industry | your space}} and thought this might be relevant.</p>
<p>We help teams like yours run outbound without the manual spreadsheet work &mdash; sequences, real Gmail threads, and replies handled in one place.</p>
<p>Worth a short conversation? I can keep it to fifteen minutes.</p>`,
  },
  {
    name: 'Follow-up 1 - short nudge',
    category: 'FOLLOWUP',
    subject: 'Re: Quick question about {{Company Name}}',
    bodyHtml: `<p>Hi {{First Name | there}},</p>
<p>Bumping this in case it slipped past &mdash; I know inboxes in {{Industry | your industry}} are busy.</p>
<p>If it is not the right time, just say so and I will close the loop.</p>`,
  },
  {
    name: 'Follow-up 2 - value add',
    category: 'FOLLOWUP',
    subject: 'Re: Quick question about {{Company Name}}',
    bodyHtml: `<p>Hi {{First Name | there}},</p>
<p>One thing teams your size usually hit first: follow-ups that keep going after someone has already replied.</p>
<p>Every sequence here stops the moment a reply lands, so that particular embarrassment is off the table.</p>
<p>Happy to show you how it works if useful.</p>`,
  },
  {
    name: 'Follow-up 3 - final',
    category: 'FOLLOWUP',
    subject: 'Re: Quick question about {{Company Name}}',
    bodyHtml: `<p>Hi {{First Name | there}},</p>
<p>Last note from me on this one. If outbound at {{Company Name}} becomes a priority later, I am easy to find.</p>
<p>All the best either way.</p>`,
  },
  {
    name: 'Pricing response',
    category: 'REPLY',
    subject: 'Re: Pricing for {{Company Name}}',
    bodyHtml: `<p>Hi {{First Name | there}},</p>
<p>Thanks for asking. Pricing depends on seats and which modules you switch on, so rather than quote a number that may not apply, tell me roughly how many people would use it and I will come back with exact figures.</p>`,
  },
];

const FIRST_NAMES = ['John', 'Sarah', 'Michael', 'Aisha', 'David', 'Elena', 'Rahul', 'Grace', 'Tom', 'Yuki', 'Omar', 'Clara', 'Ben', 'Nadia', 'Luis'];
const LAST_NAMES = ['Smith', 'Wilson', 'Chen', 'Khan', 'Brown', 'Petrova', 'Sharma', 'Adeyemi', 'Fischer', 'Tanaka', 'Haddad', 'Nowak', 'Carter', 'Rahman', 'Alvarez'];
const COMPANIES = [
  { name: 'ABC Technologies', industry: 'SaaS', city: 'Bengaluru', country: 'India', employees: '250' },
  { name: 'Northwind Logistics', industry: 'Logistics', city: 'Rotterdam', country: 'Netherlands', employees: '1200' },
  { name: 'Helios Analytics', industry: 'Data & Analytics', city: 'Austin', country: 'United States', employees: '85' },
  { name: 'Brightpath Health', industry: 'Healthcare', city: 'Manchester', country: 'United Kingdom', employees: '540' },
  { name: 'Vertex Manufacturing', industry: 'Manufacturing', city: 'Stuttgart', country: 'Germany', employees: '3200' },
  { name: 'Coral Fintech', industry: 'Fintech', city: 'Singapore', country: 'Singapore', employees: '160' },
  { name: 'Summit Legal', industry: 'Legal Services', city: 'Toronto', country: 'Canada', employees: '95' },
  { name: 'Orbit Retail Group', industry: 'Retail', city: 'Sydney', country: 'Australia', employees: '780' },
  { name: 'Lumen Energy', industry: 'Energy', city: 'Oslo', country: 'Norway', employees: '410' },
  { name: 'Kestrel Media', industry: 'Media', city: 'Dublin', country: 'Ireland', employees: '120' },
];
const TITLES = ['Chief Executive Officer', 'VP Sales', 'Head of Marketing', 'Operations Director', 'Chief Technology Officer', 'Growth Lead', 'Head of Revenue'];

function buildContacts(count: number) {
  const contacts = [];
  for (let i = 0; i < count; i += 1) {
    const firstName = FIRST_NAMES[i % FIRST_NAMES.length];
    const lastName = LAST_NAMES[(i * 3) % LAST_NAMES.length];
    const company = COMPANIES[i % COMPANIES.length];
    const domain = `${company.name.toLowerCase().replace(/[^a-z]/g, '')}.example`;

    contacts.push({
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@${domain}`,
      firstName,
      lastName,
      title: TITLES[i % TITLES.length],
      companyName: company.name,
      corporatePhone: `+1 555 0${100 + i}`,
      employees: company.employees,
      industry: company.industry,
      keywords: `${company.industry}, outbound, automation`,
      website: `https://${domain}`,
      personLinkedinUrl: `https://linkedin.com/in/${firstName.toLowerCase()}-${lastName.toLowerCase()}`,
      companyLinkedinUrl: `https://linkedin.com/company/${company.name.toLowerCase().replace(/\s+/g, '-')}`,
      companyCity: company.city,
      companyCountry: company.country,
      qualifyContact: i % 4 === 0 ? 'High' : i % 3 === 0 ? 'Medium' : 'Low',
    });
  }
  return contacts;
}

async function main() {
  console.log('\nSeeding MailFlow demo workspace...');

  const passwordHash = await bcrypt.hash(OWNER_PASSWORD, env.BCRYPT_ROUNDS);

  const organization = await prisma.organization.upsert({
    where: { slug: 'mailflow-demo' },
    create: { name: 'MailFlow Demo Ltd', slug: 'mailflow-demo', plan: 'PRO' },
    update: {},
  });

  const workspace = await prisma.workspace.upsert({
    where: { organizationId_slug: { organizationId: organization.id, slug: 'default' } },
    create: {
      organizationId: organization.id,
      name: 'Growth workspace',
      slug: 'default',
      timezone: 'Asia/Kolkata',
      settingsJson: stringifyJson({
        sendWindowStart: '09:30',
        sendWindowEnd: '17:30',
        defaultDailyLimit: 100,
        skipWhenOutOfOffice: true,
        notifyOnReply: true,
        notifyOnFailure: true,
      }),
    },
    update: {},
  });

  for (const member of TEAM) {
    const user = await prisma.user.upsert({
      where: { email: member.email },
      create: {
        email: member.email,
        passwordHash,
        firstName: member.firstName,
        lastName: member.lastName,
        organizationId: organization.id,
        timezone: 'Asia/Kolkata',
      },
      update: { passwordHash, organizationId: organization.id },
    });

    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      create: { workspaceId: workspace.id, userId: user.id, role: member.role },
      update: { role: member.role },
    });
  }
  console.log(`  users        : ${TEAM.length} (every role represented)`);

  const mailboxes = [];
  for (const mailbox of MAILBOXES) {
    const account = await prisma.emailAccount.upsert({
      where: { workspaceId_email: { workspaceId: workspace.id, email: mailbox.email } },
      create: {
        workspaceId: workspace.id,
        email: mailbox.email,
        displayName: mailbox.displayName,
        dailyLimit: mailbox.dailyLimit,
        hourlyLimit: Math.round(mailbox.dailyLimit / 5),
        signatureHtml: `<p style="color:#475569;font-size:13px">${mailbox.displayName}<br>MailFlow Demo Ltd</p>`,
      },
      update: {},
    });
    await prisma.emailSession.upsert({
      where: { id: `${account.id}-session` },
      create: { id: `${account.id}-session`, emailAccountId: account.id },
      update: {},
    });
    mailboxes.push(account);
  }
  console.log(`  mailboxes    : ${mailboxes.length}`);

  const templates = [];
  for (const template of TEMPLATES) {
    templates.push(
      await prisma.emailTemplate.upsert({
        where: { workspaceId_name: { workspaceId: workspace.id, name: template.name } },
        create: {
          workspaceId: workspace.id,
          name: template.name,
          category: template.category,
          subject: template.subject,
          bodyHtml: template.bodyHtml,
          bodyText: template.bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        },
        update: {},
      }),
    );
  }
  console.log(`  templates    : ${templates.length}`);

  const list = await prisma.contactList.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: 'Q3 SaaS prospects' } },
    create: {
      workspaceId: workspace.id,
      name: 'Q3 SaaS prospects',
      description: 'Seed list of decision makers across ten target accounts',
    },
    update: {},
  });

  const contacts = buildContacts(45);
  let contactCount = 0;
  for (const contact of contacts) {
    const record = await prisma.contact.upsert({
      where: { workspaceId_email: { workspaceId: workspace.id, email: contact.email } },
      create: { workspaceId: workspace.id, ...contact },
      update: {},
    });
    await prisma.contactListMember
      .upsert({
        where: { listId_contactId: { listId: list.id, contactId: record.id } },
        create: { listId: list.id, contactId: record.id },
        update: {},
      })
      .catch(() => undefined);
    contactCount += 1;
  }
  console.log(`  contacts     : ${contactCount} in "${list.name}"`);

  const existingCampaign = await prisma.campaign.findFirst({
    where: { workspaceId: workspace.id, name: 'SaaS Outreach - Q3' },
  });

  const campaign =
    existingCampaign ??
    (await prisma.campaign.create({
      data: {
        workspaceId: workspace.id,
        name: 'SaaS Outreach - Q3',
        description: 'Four-step sequence to decision makers at target SaaS and adjacent accounts.',
        emailAccountId: mailboxes[0].id,
        contactListId: list.id,
        status: 'DRAFT',
        mode: 'SEND',
        timezone: 'Asia/Kolkata',
        sendWindowStart: '09:30',
        sendWindowEnd: '17:30',
        sendDaysJson: stringifyJson([1, 2, 3, 4, 5]),
        dailyLimit: 50,
        // Short delays so the demo campaign visibly moves. Production defaults
        // in the schema are 30-60s; raise these before pointing at a real
        // mailbox so provider rate limits are respected.
        minDelaySec: 6,
        maxDelaySec: 14,
        randomDelay: true,
        stopOnReply: true,
        createdById: (await prisma.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } })).id,
      },
    }));

  const stepDefs = [
    { order: 1, name: 'Initial email', type: 'INITIAL', template: templates[0], delayDays: 0, reply: false },
    { order: 2, name: 'Follow-up 1', type: 'FOLLOWUP', template: templates[1], delayDays: 3, reply: true },
    { order: 3, name: 'Follow-up 2', type: 'FOLLOWUP', template: templates[2], delayDays: 7, reply: true },
    { order: 4, name: 'Follow-up 3', type: 'FOLLOWUP', template: templates[3], delayDays: 14, reply: true },
  ];

  for (const def of stepDefs) {
    await prisma.campaignStep.upsert({
      where: { campaignId_stepOrder: { campaignId: campaign.id, stepOrder: def.order } },
      create: {
        campaignId: campaign.id,
        stepOrder: def.order,
        name: def.name,
        type: def.type,
        templateId: def.template.id,
        delayDays: def.delayDays,
        replyInThread: def.reply,
      },
      update: { templateId: def.template.id },
    });
  }

  const members = await prisma.contactListMember.findMany({ where: { listId: list.id }, select: { contactId: true } });
  for (const member of members) {
    await prisma.campaignContact
      .upsert({
        where: { campaignId_contactId: { campaignId: campaign.id, contactId: member.contactId } },
        create: { campaignId: campaign.id, contactId: member.contactId, status: 'NEW' },
        update: {},
      })
      .catch(() => undefined);
  }
  console.log(`  campaign     : "${campaign.name}" with ${stepDefs.length} steps and ${members.length} contacts`);

  await prisma.suppressionList.upsert({
    where: { workspaceId_value: { workspaceId: workspace.id, value: 'competitor.example' } },
    create: {
      workspaceId: workspace.id,
      value: 'competitor.example',
      scope: 'DOMAIN',
      type: 'DOMAIN_BLOCK',
      reason: 'Competitor domain - never contact',
    },
    update: {},
  });

  await prisma.systemSetting.upsert({
    where: { workspaceId_key: { workspaceId: workspace.id, key: 'ai' } },
    create: {
      workspaceId: workspace.id,
      key: 'ai',
      isSecret: true,
      valueJson: stringifyJson({
        provider: 'local',
        apiKeyEncrypted: null,
        model: null,
        temperature: 0.4,
        maxTokens: 800,
        defaultStyle: 'PROFESSIONAL',
        defaultLength: 'MEDIUM',
        enableIntentDetection: true,
        enableThreadSummary: true,
        enableAIReply: true,
        autoGenerateReplies: true,
        analyzeScope: 'CAMPAIGN_REPLIES',
        externalAIEnabled: true,
      }),
    },
    update: {},
  });

  await prisma.notification.create({
    data: {
      workspaceId: workspace.id,
      type: 'DAILY_DIGEST',
      severity: 'INFO',
      title: 'Welcome to MailFlow',
      body: 'Your demo workspace is ready. Open Campaigns, then start "SaaS Outreach - Q3" to watch the pipeline run.',
      linkUrl: '/campaigns',
    },
  });

  console.log(`
=====================================================================
  Demo workspace ready.

  URL       http://localhost:5173
  Email     ${OWNER_EMAIL}
  Password  ${OWNER_PASSWORD}

  The same password works for the other seeded roles:
    admin.user@mailflow.local   (ADMIN)
    manager@mailflow.local      (MANAGER)
    user@mailflow.local         (USER)
    viewer@mailflow.local       (VIEWER)
=====================================================================
`);
}

main()
  .catch((error) => {
    console.error('[seed] failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
