import { Router } from 'express';
import multer from 'multer';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import { prisma } from '@mail/database';
import { addSuppression, logActivity } from '@mail/core';
import {
  bulkContactActionSchema,
  contactListSchema,
  contactQuerySchema,
  contactSchema,
  importCommitSchema,
  normalizeEmail,
  parseList,
  parseJson,
  stringifyJson,
  isEmail,
} from '@mail/shared';
import type { ContactRecord } from '@mail/shared';
import { AppError, handler, ok, paginate } from '../lib/http.js';
import { authenticate, requireWrite, withWorkspace } from '../middleware/context.js';

export const contactRouter = Router();
contactRouter.use(authenticate, withWorkspace);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/** Canonical import targets offered by the column mapper. */
export const IMPORT_FIELDS = [
  { key: 'email', label: 'Email', required: true, aliases: ['email', 'emailaddress', 'workemail', 'e-mail'] },
  { key: 'firstName', label: 'First Name', aliases: ['firstname', 'first', 'givenname', 'fname'] },
  { key: 'lastName', label: 'Last Name', aliases: ['lastname', 'last', 'surname', 'familyname', 'lname'] },
  { key: 'title', label: 'Title', aliases: ['title', 'jobtitle', 'position', 'role'] },
  { key: 'companyName', label: 'Company Name', aliases: ['companyname', 'company', 'organization', 'account'] },
  { key: 'corporatePhone', label: 'Corporate Phone', aliases: ['corporatephone', 'phone', 'companyphone', 'telephone'] },
  { key: 'employees', label: 'Employees', aliases: ['employees', 'employeecount', 'headcount', 'size'] },
  { key: 'industry', label: 'Industry', aliases: ['industry', 'sector', 'vertical'] },
  { key: 'keywords', label: 'Keywords', aliases: ['keywords', 'tags', 'technologies'] },
  { key: 'personLinkedinUrl', label: 'Person LinkedIn URL', aliases: ['personlinkedinurl', 'linkedin', 'linkedinurl'] },
  { key: 'website', label: 'Website', aliases: ['website', 'domain', 'url', 'companywebsite'] },
  { key: 'companyLinkedinUrl', label: 'Company LinkedIn URL', aliases: ['companylinkedinurl', 'companylinkedin'] },
  { key: 'companyAddress', label: 'Company Address', aliases: ['companyaddress', 'address', 'street'] },
  { key: 'companyCity', label: 'Company City', aliases: ['companycity', 'city'] },
  { key: 'companyState', label: 'Company State', aliases: ['companystate', 'state', 'province', 'region'] },
  { key: 'companyCountry', label: 'Company Country', aliases: ['companycountry', 'country'] },
  { key: 'qualifyContact', label: 'Qualify Contact', aliases: ['qualifycontact', 'qualified', 'qualify'] },
] as const;

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Best-effort automatic column mapping, shown to the user for confirmation. */
export function suggestMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const header of headers) {
    const norm = normalizeHeader(header);
    const field = IMPORT_FIELDS.find(
      (f) => (f.aliases as readonly string[]).includes(norm) || normalizeHeader(f.label) === norm,
    );
    if (field && !Object.values(mapping).includes(field.key)) mapping[header] = field.key;
  }
  return mapping;
}

function toRecord(row: {
  tagsJson: string;
  customJson: string;
  [k: string]: unknown;
}): ContactRecord {
  const { tagsJson, customJson, ...rest } = row;
  return {
    ...(rest as unknown as ContactRecord),
    tags: parseList(tagsJson),
    custom: parseJson<Record<string, string>>(customJson, {}),
  };
}

// ------------------------------------------------------------------- lists

contactRouter.get(
  '/lists',
  handler(async (req, res) => {
    const lists = await prisma.contactList.findMany({
      where: { workspaceId: req.ctx.workspaceId },
      include: { _count: { select: { members: true, campaigns: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return ok(
      res,
      lists.map((l) => ({
        id: l.id,
        name: l.name,
        description: l.description,
        contactCount: l._count.members,
        campaignCount: l._count.campaigns,
        createdAt: l.createdAt,
      })),
    );
  }),
);

contactRouter.post(
  '/lists',
  requireWrite,
  handler(async (req, res) => {
    const input = contactListSchema.parse(req.body);
    const list = await prisma.contactList.create({
      data: { workspaceId: req.ctx.workspaceId, name: input.name, description: input.description ?? null },
    });
    return ok(res, list, undefined, 201);
  }),
);

contactRouter.patch(
  '/lists/:id',
  requireWrite,
  handler(async (req, res) => {
    const input = contactListSchema.partial().parse(req.body);
    const list = await prisma.contactList.updateMany({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
      data: input,
    });
    if (!list.count) throw AppError.notFound('List');
    return ok(res, { updated: true });
  }),
);

contactRouter.delete(
  '/lists/:id',
  requireWrite,
  handler(async (req, res) => {
    const deleted = await prisma.contactList.deleteMany({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!deleted.count) throw AppError.notFound('List');
    return ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------------ import

contactRouter.post(
  '/import/parse',
  requireWrite,
  upload.single('file'),
  handler(async (req, res) => {
    if (!req.file) throw AppError.badRequest('Upload a CSV or XLSX file');

    const name = req.file.originalname.toLowerCase();
    let headers: string[] = [];
    let rows: Record<string, string>[] = [];

    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      const parsed = Papa.parse<Record<string, string>>(req.file.buffer.toString('utf8'), {
        header: true,
        skipEmptyLines: 'greedy',
        transformHeader: (h) => h.trim(),
      });
      headers = parsed.meta.fields ?? [];
      rows = parsed.data.filter(Boolean);
    } else if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) throw AppError.badRequest('The workbook has no sheets');

      const headerRow = sheet.getRow(1);
      headers = (headerRow.values as unknown[]).slice(1).map((v) => String(v ?? '').trim());

      sheet.eachRow((row, index) => {
        if (index === 1) return;
        const values = (row.values as unknown[]).slice(1);
        const record: Record<string, string> = {};
        headers.forEach((header, i) => {
          const value = values[i];
          record[header] =
            value && typeof value === 'object' && 'text' in (value as object)
              ? String((value as { text: unknown }).text ?? '')
              : String(value ?? '');
        });
        rows.push(record);
      });
    } else {
      throw AppError.badRequest('Only .csv and .xlsx files are supported');
    }

    const mapping = suggestMapping(headers);
    const emailColumn = Object.entries(mapping).find(([, field]) => field === 'email')?.[0];

    // Validate before anything is written, and show the user what will happen.
    const seen = new Set<string>();
    let valid = 0;
    let invalid = 0;
    let duplicates = 0;
    const errors: Array<{ row: number; message: string }> = [];

    rows.forEach((row, index) => {
      const email = normalizeEmail(emailColumn ? String(row[emailColumn] ?? '') : '');
      if (!email || !isEmail(email)) {
        invalid += 1;
        if (errors.length < 25) errors.push({ row: index + 2, message: email ? `Invalid email "${email}"` : 'Missing email' });
        return;
      }
      if (seen.has(email)) {
        duplicates += 1;
        return;
      }
      seen.add(email);
      valid += 1;
    });

    const existing = await prisma.contact.count({
      where: { workspaceId: req.ctx.workspaceId, email: { in: [...seen].slice(0, 5000) } },
    });

    return ok(res, {
      headers,
      fields: IMPORT_FIELDS,
      mapping,
      preview: rows.slice(0, 10),
      totalRows: rows.length,
      rows: rows.slice(0, 20000),
      stats: { valid, invalid, duplicatesInFile: duplicates, alreadyInWorkspace: existing },
      errors,
    });
  }),
);

contactRouter.post(
  '/import/commit',
  requireWrite,
  handler(async (req, res) => {
    const input = importCommitSchema.parse(req.body);
    const emailColumn = Object.entries(input.mapping).find(([, field]) => field === 'email')?.[0];
    if (!emailColumn) throw AppError.badRequest('Map a column to Email before importing');

    let listId = input.listId ?? null;
    if (input.createList) {
      const list = await prisma.contactList.create({
        data: { workspaceId: req.ctx.workspaceId, name: input.createList },
      });
      listId = list.id;
    }

    const knownFields = new Set(IMPORT_FIELDS.map((f) => f.key as string));
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of input.rows) {
      const email = normalizeEmail(String(row[emailColumn] ?? ''));
      if (!email || !isEmail(email)) {
        skipped += 1;
        continue;
      }

      const data: Record<string, string> = {};
      const custom: Record<string, string> = {};
      for (const [column, field] of Object.entries(input.mapping)) {
        const value = row[column];
        if (value === null || value === undefined || value === '') continue;
        if (field === 'email') continue;
        if (knownFields.has(field)) data[field] = String(value).slice(0, 400);
        else custom[field] = String(value).slice(0, 400);
      }

      const existing = await prisma.contact.findUnique({
        where: { workspaceId_email: { workspaceId: req.ctx.workspaceId, email } },
      });

      let contactId: string;
      if (existing) {
        if (!input.updateExisting && input.skipDuplicates) {
          skipped += 1;
          contactId = existing.id;
        } else {
          const merged = { ...parseJson<Record<string, string>>(existing.customJson, {}), ...custom };
          await prisma.contact.update({
            where: { id: existing.id },
            data: { ...data, customJson: stringifyJson(merged) },
          });
          updated += 1;
          contactId = existing.id;
        }
      } else {
        const contact = await prisma.contact.create({
          data: {
            workspaceId: req.ctx.workspaceId,
            email,
            ...data,
            customJson: stringifyJson(custom),
          },
        });
        created += 1;
        contactId = contact.id;
      }

      if (listId) {
        await prisma.contactListMember
          .create({ data: { listId, contactId } })
          .catch(() => undefined); // already a member
      }
    }

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      action: 'contacts.imported',
      message: `Imported ${created} new, updated ${updated}, skipped ${skipped}`,
    });

    return ok(res, { created, updated, skipped, listId });
  }),
);

contactRouter.get(
  '/export',
  handler(async (req, res) => {
    const contacts = await prisma.contact.findMany({
      where: { workspaceId: req.ctx.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 50000,
    });

    const columns = IMPORT_FIELDS.map((f) => f.key);
    const csv = Papa.unparse(
      contacts.map((c) => {
        const row: Record<string, unknown> = {};
        for (const key of columns) row[key] = (c as Record<string, unknown>)[key] ?? '';
        row.status = c.status;
        row.tags = parseList(c.tagsJson).join('|');
        return row;
      }),
    );

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="contacts-${Date.now()}.csv"`);
    return res.send(csv);
  }),
);

// ---------------------------------------------------------------- contacts

contactRouter.get(
  '/',
  handler(async (req, res) => {
    const query = contactQuerySchema.parse(req.query);
    const where: Record<string, unknown> = { workspaceId: req.ctx.workspaceId };

    if (query.status) where.status = query.status;
    if (query.listId) where.listMembers = { some: { listId: query.listId } };
    if (query.tag) where.tagsJson = { contains: `"${query.tag}"` };
    if (query.q) {
      const q = query.q.trim();
      where.OR = [
        { email: { contains: q } },
        { firstName: { contains: q } },
        { lastName: { contains: q } },
        { companyName: { contains: q } },
        { title: { contains: q } },
        { industry: { contains: q } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { [query.sort]: query.order },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.contact.count({ where }),
    ]);

    return ok(res, paginate(rows.map((r) => toRecord(r as never)), total, query.page, query.pageSize));
  }),
);

contactRouter.get(
  '/:id',
  handler(async (req, res) => {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
      include: {
        listMembers: { include: { list: { select: { id: true, name: true } } } },
        campaignContacts: {
          include: { campaign: { select: { id: true, name: true, status: true } } },
          orderBy: { createdAt: 'desc' },
        },
        threads: {
          select: { id: true, subject: true, lastMessageAt: true, status: true, gmailThreadId: true },
          orderBy: { lastMessageAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!contact) throw AppError.notFound('Contact');

    const events = await prisma.emailEvent.findMany({
      where: { contactId: contact.id },
      include: { campaign: { select: { name: true } }, step: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const timeline = [
      {
        id: `created-${contact.id}`,
        type: 'CONTACT_ADDED',
        label: 'Contact added',
        detail: null,
        campaignName: null,
        createdAt: contact.createdAt.toISOString(),
      },
      ...events.map((e) => ({
        id: e.id,
        type: e.type,
        label:
          {
            SENT: 'Email sent',
            DRAFT_CREATED: 'Draft created',
            REPLY_RECEIVED: 'Reply received',
            BOUNCED: 'Message bounced',
            UNSUBSCRIBED: 'Unsubscribed',
            FAILED: 'Send failed',
            SKIPPED: 'Send skipped',
            OPENED: 'Email opened',
          }[e.type] ?? e.type,
        detail: e.step?.name ?? null,
        campaignName: e.campaign?.name ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    return ok(res, {
      ...toRecord(contact as never),
      lists: contact.listMembers.map((m) => m.list),
      campaigns: contact.campaignContacts.map((cc) => ({
        id: cc.campaign.id,
        name: cc.campaign.name,
        campaignStatus: cc.campaign.status,
        status: cc.status,
        currentStep: cc.currentStep,
        nextStepAt: cc.nextStepAt,
        repliedAt: cc.repliedAt,
      })),
      threads: contact.threads,
      timeline,
    });
  }),
);

contactRouter.post(
  '/',
  requireWrite,
  handler(async (req, res) => {
    const input = contactSchema.parse(req.body);
    const { tags, custom, ...rest } = input;
    const contact = await prisma.contact.create({
      data: {
        workspaceId: req.ctx.workspaceId,
        ...rest,
        tagsJson: stringifyJson(tags ?? []),
        customJson: stringifyJson(custom ?? {}),
      },
    });
    return ok(res, toRecord(contact as never), undefined, 201);
  }),
);

contactRouter.patch(
  '/:id',
  requireWrite,
  handler(async (req, res) => {
    const input = contactSchema.partial().parse(req.body);
    const { tags, custom, ...rest } = input;

    const existing = await prisma.contact.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!existing) throw AppError.notFound('Contact');

    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: {
        ...rest,
        ...(tags ? { tagsJson: stringifyJson(tags) } : {}),
        ...(custom ? { customJson: stringifyJson(custom) } : {}),
      },
    });
    return ok(res, toRecord(contact as never));
  }),
);

contactRouter.delete(
  '/:id',
  requireWrite,
  handler(async (req, res) => {
    const deleted = await prisma.contact.deleteMany({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!deleted.count) throw AppError.notFound('Contact');
    return ok(res, { deleted: true });
  }),
);

contactRouter.post(
  '/bulk',
  requireWrite,
  handler(async (req, res) => {
    const input = bulkContactActionSchema.parse(req.body);
    const scope = { id: { in: input.ids }, workspaceId: req.ctx.workspaceId };
    const contacts = await prisma.contact.findMany({ where: scope, select: { id: true, email: true, tagsJson: true } });
    if (!contacts.length) throw AppError.notFound('Contacts');
    const ids = contacts.map((c) => c.id);

    switch (input.action) {
      case 'DELETE':
        await prisma.contact.deleteMany({ where: scope });
        break;

      case 'ADD_TO_LIST': {
        if (!input.listId) throw AppError.badRequest('Choose a list');
        for (const id of ids) {
          await prisma.contactListMember
            .create({ data: { listId: input.listId, contactId: id } })
            .catch(() => undefined);
        }
        break;
      }

      case 'REMOVE_FROM_LIST':
        if (!input.listId) throw AppError.badRequest('Choose a list');
        await prisma.contactListMember.deleteMany({ where: { listId: input.listId, contactId: { in: ids } } });
        break;

      case 'SET_STATUS':
        if (!input.status) throw AppError.badRequest('Choose a status');
        await prisma.contact.updateMany({ where: scope, data: { status: input.status } });
        break;

      case 'ADD_TAG': {
        if (!input.tag) throw AppError.badRequest('Provide a tag');
        for (const contact of contacts) {
          const tags = new Set(parseList(contact.tagsJson));
          tags.add(input.tag);
          await prisma.contact.update({
            where: { id: contact.id },
            data: { tagsJson: stringifyJson([...tags]) },
          });
        }
        break;
      }

      case 'SUPPRESS':
        for (const contact of contacts) {
          await addSuppression({
            workspaceId: req.ctx.workspaceId,
            value: contact.email,
            type: 'MANUAL_BLOCK',
            reason: 'Blocked in bulk from the contacts screen',
          });
        }
        await prisma.contact.updateMany({ where: scope, data: { status: 'UNSUBSCRIBED' } });
        break;
    }

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      action: `contacts.bulk_${input.action.toLowerCase()}`,
      message: `${input.action} applied to ${ids.length} contact(s)`,
    });

    return ok(res, { affected: ids.length });
  }),
);
