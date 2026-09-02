import { Router } from 'express';
import multer from 'multer';
import { prisma } from '@mail/database';
import { env } from '@mail/config';
import { isAllowedUpload, storage } from '@mail/core';
import {
  STANDARD_VARIABLES,
  contactToContext,
  extractVariables,
  htmlToText,
  renderTemplate,
  templatePreviewSchema,
  templateSchema,
  validateTemplate,
} from '@mail/shared';
import { AppError, handler, ok } from '../lib/http.js';
import { authenticate, requireWrite, withWorkspace } from '../middleware/context.js';

export const templateRouter = Router();
templateRouter.use(authenticate, withWorkspace);

templateRouter.get(
  '/',
  handler(async (req, res) => {
    const templates = await prisma.emailTemplate.findMany({
      where: { workspaceId: req.ctx.workspaceId, isArchived: false },
      include: {
        templateAttachments: { include: { attachment: true } },
        _count: { select: { steps: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return ok(
      res,
      templates.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        subject: t.subject,
        bodyHtml: t.bodyHtml,
        bodyText: t.bodyText,
        description: t.description,
        usedInSteps: t._count.steps,
        variables: [...new Set([...extractVariables(t.subject), ...extractVariables(t.bodyHtml)])],
        attachments: t.templateAttachments.map((ta) => ({
          id: ta.attachment.id,
          filename: ta.attachment.originalName,
          size: ta.attachment.size,
          mimeType: ta.attachment.mimeType,
        })),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    );
  }),
);

templateRouter.get(
  '/variables',
  handler(async (req, res) => {
    // Standard merge fields plus every custom key actually present on contacts.
    const sample = await prisma.contact.findMany({
      where: { workspaceId: req.ctx.workspaceId },
      select: { customJson: true },
      take: 200,
    });
    const custom = new Set<string>();
    for (const row of sample) {
      try {
        Object.keys(JSON.parse(row.customJson) as Record<string, unknown>).forEach((k) => custom.add(k));
      } catch {
        /* ignore malformed blobs */
      }
    }
    return ok(res, { standard: STANDARD_VARIABLES, custom: [...custom].sort() });
  }),
);

templateRouter.post(
  '/preview',
  handler(async (req, res) => {
    const input = templatePreviewSchema.parse(req.body);

    let context: Record<string, string> = {
      'First Name': 'John',
      'Last Name': 'Smith',
      'Full Name': 'John Smith',
      Title: 'Chief Executive Officer',
      'Company Name': 'ABC Technologies',
      Email: 'john.smith@abctech.example',
      Industry: 'SaaS',
      Website: 'abctech.example',
      'Company City': 'Bengaluru',
      'Company Country': 'India',
      Employees: '250',
    };

    if (input.contactId) {
      const contact = await prisma.contact.findFirst({
        where: { id: input.contactId, workspaceId: req.ctx.workspaceId },
      });
      if (contact) context = contactToContext(contact as unknown as Record<string, unknown>) as Record<string, string>;
    }
    if (input.sample) context = { ...context, ...input.sample };

    const subject = renderTemplate(input.subject, context);
    const body = renderTemplate(input.bodyHtml, context);
    const known = [...STANDARD_VARIABLES, ...Object.keys(context)];

    return ok(res, {
      subject: subject.output,
      bodyHtml: body.output,
      bodyText: htmlToText(body.output),
      context,
      variables: [...new Set([...extractVariables(input.subject), ...extractVariables(input.bodyHtml)])],
      issues: [
        ...validateTemplate(input.subject, known, context),
        ...validateTemplate(input.bodyHtml, known, context),
      ],
    });
  }),
);

templateRouter.get(
  '/:id',
  handler(async (req, res) => {
    const template = await prisma.emailTemplate.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
      include: { templateAttachments: { include: { attachment: true } } },
    });
    if (!template) throw AppError.notFound('Template');
    return ok(res, {
      ...template,
      attachmentIds: template.templateAttachments.map((ta) => ta.attachmentId),
      attachments: template.templateAttachments.map((ta) => ({
        id: ta.attachment.id,
        filename: ta.attachment.originalName,
        size: ta.attachment.size,
        mimeType: ta.attachment.mimeType,
      })),
    });
  }),
);

templateRouter.post(
  '/',
  requireWrite,
  handler(async (req, res) => {
    const input = templateSchema.parse(req.body);
    const template = await prisma.emailTemplate.create({
      data: {
        workspaceId: req.ctx.workspaceId,
        name: input.name,
        category: input.category,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        bodyText: input.bodyText ?? htmlToText(input.bodyHtml),
        description: input.description ?? null,
        templateAttachments: input.attachmentIds?.length
          ? { create: input.attachmentIds.map((attachmentId) => ({ attachmentId })) }
          : undefined,
      },
    });
    return ok(res, template, undefined, 201);
  }),
);

templateRouter.patch(
  '/:id',
  requireWrite,
  handler(async (req, res) => {
    const input = templateSchema.partial().parse(req.body);
    const existing = await prisma.emailTemplate.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!existing) throw AppError.notFound('Template');

    if (input.attachmentIds) {
      await prisma.templateAttachment.deleteMany({ where: { templateId: existing.id } });
      for (const attachmentId of input.attachmentIds) {
        await prisma.templateAttachment.create({ data: { templateId: existing.id, attachmentId } });
      }
    }

    const template = await prisma.emailTemplate.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        category: input.category,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        bodyText: input.bodyText ?? (input.bodyHtml ? htmlToText(input.bodyHtml) : undefined),
        description: input.description,
      },
    });
    return ok(res, template);
  }),
);

templateRouter.post(
  '/:id/duplicate',
  requireWrite,
  handler(async (req, res) => {
    const source = await prisma.emailTemplate.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
      include: { templateAttachments: true },
    });
    if (!source) throw AppError.notFound('Template');

    let name = `${source.name} (copy)`;
    for (
      let i = 2;
      await prisma.emailTemplate.findUnique({
        where: { workspaceId_name: { workspaceId: req.ctx.workspaceId, name } },
      });
      i += 1
    ) {
      name = `${source.name} (copy ${i})`;
    }

    const copy = await prisma.emailTemplate.create({
      data: {
        workspaceId: req.ctx.workspaceId,
        name,
        category: source.category,
        subject: source.subject,
        bodyHtml: source.bodyHtml,
        bodyText: source.bodyText,
        description: source.description,
        templateAttachments: {
          create: source.templateAttachments.map((ta) => ({ attachmentId: ta.attachmentId })),
        },
      },
    });
    return ok(res, copy, undefined, 201);
  }),
);

templateRouter.delete(
  '/:id',
  requireWrite,
  handler(async (req, res) => {
    const deleted = await prisma.emailTemplate.deleteMany({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!deleted.count) throw AppError.notFound('Template');
    return ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------- attachments

export const attachmentRouter = Router();
attachmentRouter.use(authenticate, withWorkspace);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes },
});

attachmentRouter.get(
  '/',
  handler(async (req, res) => {
    const attachments = await prisma.attachment.findMany({
      where: { workspaceId: req.ctx.workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return ok(
      res,
      attachments.map((a) => ({
        id: a.id,
        filename: a.originalName,
        mimeType: a.mimeType,
        size: a.size,
        createdAt: a.createdAt,
      })),
    );
  }),
);

attachmentRouter.post(
  '/',
  requireWrite,
  upload.single('file'),
  handler(async (req, res) => {
    if (!req.file) throw AppError.badRequest('No file was uploaded');
    if (!isAllowedUpload(req.file.mimetype)) {
      throw AppError.badRequest(`Files of type ${req.file.mimetype} are not allowed`, 'UNSUPPORTED_FILE_TYPE');
    }

    const stored = await storage.save(req.file.buffer, req.file.originalname);
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId: req.ctx.workspaceId,
        filename: stored.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: stored.size,
        storagePath: stored.storagePath,
        checksum: stored.checksum,
      },
    });

    return ok(
      res,
      { id: attachment.id, filename: attachment.originalName, mimeType: attachment.mimeType, size: attachment.size },
      undefined,
      201,
    );
  }),
);

attachmentRouter.get(
  '/:id/download',
  handler(async (req, res) => {
    // Private by design: files are only reachable through this authorised route,
    // never as a static mount.
    const attachment = await prisma.attachment.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!attachment || !storage.exists(attachment.storagePath)) throw AppError.notFound('Attachment');

    res.setHeader('content-type', attachment.mimeType);
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(attachment.originalName)}"`);
    return res.sendFile(storage.resolve(attachment.storagePath));
  }),
);

attachmentRouter.patch(
  '/:id',
  requireWrite,
  handler(async (req, res) => {
    const name = String(req.body?.filename ?? '').trim();
    if (!name) throw AppError.badRequest('Provide a filename');
    const updated = await prisma.attachment.updateMany({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
      data: { originalName: name.slice(0, 200) },
    });
    if (!updated.count) throw AppError.notFound('Attachment');
    return ok(res, { renamed: true });
  }),
);

attachmentRouter.delete(
  '/:id',
  requireWrite,
  handler(async (req, res) => {
    const attachment = await prisma.attachment.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!attachment) throw AppError.notFound('Attachment');
    await storage.remove(attachment.storagePath);
    await prisma.attachment.delete({ where: { id: attachment.id } });
    return ok(res, { deleted: true });
  }),
);
