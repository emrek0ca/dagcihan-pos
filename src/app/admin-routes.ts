/**
 * Yonetim uc noktalari.
 *
 * ONEMLI: Burada IS MANTIGI YOKTUR. Her uc nokta mevcut servisleri
 * (ProductService, InventoryService, UserService, CashRegisterService,
 * SalesService, PrintQueue, ScanResolver, ReportService) cagirir.
 * Ayri bir yonetim backend'i olusturulmamistir.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PosApplication } from './pos.ts';
import { PosError } from '../core/errors.ts';
import { money, type BasisPoints } from '../core/money/money.ts';
import { quantity, type Quantity } from '../core/quantity/quantity.ts';
import { requirePermission, type Permission, type Role, type User } from '../modules/users/users.ts';
import { ReportService } from '../modules/reports/reports.ts';
import { analyzeSamples, type BarcodeSample } from '../core/barcode/analyzer.ts';
import { validateConfig } from '../core/barcode/parser.ts';
import type { WeightedBarcodeRule } from '../core/barcode/types.ts';
import { renderCodePageTest } from '../modules/printing/render.ts';
import {
  listHidCandidates, listSerialPorts, listWindowsPrinters,
  scanNetworkPrinters, shareWindowsPrinter,
} from '../hardware/discovery.ts';
import { CODE_PAGE_CANDIDATES } from '../hardware/printer/encoding.ts';
import { verifyAuditChain } from '../modules/audit/audit.ts';
import type { MovementType } from '../modules/inventory/inventory.ts';
import type { ScalePluItem } from '../hardware/ports.ts';

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly session: { readonly user: User } | null;
}

export interface AdminRouteDeps {
  readonly app: PosApplication;
  readonly route: (
    method: string,
    path: string,
    handler: (context: RouteContext) => unknown,
  ) => void;
  readonly requireUser: (context: RouteContext) => User;
  readonly pushState: () => void;
  readonly configFiles: { posConfigFile: string; barcodeConfigFile: string };
}

// ------------------------------ yardimcilar ------------------------------

function num(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new PosError('INTERNAL', `${field} sayi olmali`, { userMessage: `${field} gecersiz.` });
  }
  return n;
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PosError('INTERNAL', `${field} zorunlu`, { userMessage: `${field} bos olamaz.` });
  }
  return value.trim();
}

function readJsonFile<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function writeJsonFile(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function todayOf(app: PosApplication): string {
  return app.clock.businessDate();
}

export function registerAdminRoutes(deps: AdminRouteDeps): void {
  const { app, route, requireUser, pushState, configFiles } = deps;
  const reports = new ReportService(app.db);

  /** Ayar dosyasini oku - degistir - yaz (tek yerden, tutarli) */
  const patchConfig = (mutate: (file: Record<string, any>) => void): void => {
    const file = readJsonFile<Record<string, any>>(configFiles.posConfigFile);
    mutate(file);
    writeJsonFile(configFiles.posConfigFile, file);
  };

  const guard = (context: RouteContext, permission: Permission): User => {
    const user = requireUser(context);
    requirePermission(user, permission);
    return user;
  };

  // ============================ ILK KURULUM ============================
  // Temiz bir bilgisayarda uygulama acildiginda kasiyer terminal kullanmasin diye
  // ilk yonetici hesabi arayuzden olusturulur. Yalnizca HIC kullanici yokken calisir.

  route('GET', '/api/setup/status', () => ({
    needsSetup: app.users.list().length === 0,
    productCount: app.products.count(),
    weightedFormatConfirmed: app.barcodeConfig.weightedFormatConfirmed,
    store: app.config.store.name,
    // Magaza adi bos ise kurulumda sorulur (urun birden fazla musteriye kurulur)
    needsStoreName: app.config.store.name.trim() === '',
    defaultServerUrl: app.config.sync.serverUrl,
    terminalCode: app.config.terminal.code,
  }));

  route('POST', '/api/setup/admin', ({ body }) => {
    if (app.users.list().length > 0) {
      throw new PosError('UNAUTHORIZED', 'Kurulum zaten tamamlanmis', {
        userMessage: 'Kurulum daha once yapilmis.',
      });
    }
    const user = app.users.create({
      username: str(body.username, 'Kullanici adi'),
      displayName: str(body.displayName, 'Ad soyad'),
      pin: str(body.pin, 'PIN'),
      role: 'ADMIN',
    });

    // Magaza adi ve kasa kodu ilk kurulumda yazilir; her musteri kendi bilgisini girer
    const storeName = typeof body.storeName === 'string' ? body.storeName.trim() : '';
    const terminalCode = typeof body.terminalCode === 'string' ? body.terminalCode.trim() : '';
    if (storeName !== '' || terminalCode !== '') {
      const file = readJsonFile<Record<string, any>>(configFiles.posConfigFile);
      if (storeName !== '') file.store.name = storeName;
      if (terminalCode !== '') {
        file.terminal.code = terminalCode;
        file.terminal.name = terminalCode;
      }
      writeJsonFile(configFiles.posConfigFile, file);
    }

    return {
      id: user.id,
      username: user.username,
      restartRequired: storeName !== '' || terminalCode !== '',
    };
  });

  // ============================ URUNLER ============================

  route('GET', '/api/admin/products', (context) => {
    guard(context, 'PRODUCT_MANAGE');
    const term = context.url.searchParams.get('q') ?? '';
    const products = term.trim() === ''
      ? app.products.list({ limit: Number(context.url.searchParams.get('limit') ?? 200) })
      : app.products.search(term, 200);
    return products.map((p) => ({
      ...p,
      plus: app.products.pluListFor(p.id),
      barcodes: app.products.barcodesFor(p.id),
    }));
  });

  route('GET', '/api/admin/products/:id', (context) => {
    guard(context, 'PRODUCT_MANAGE');
    const id = num(context.params.id, 'id');
    return {
      ...app.products.byId(id),
      plus: app.products.pluListFor(id),
      barcodes: app.products.barcodesFor(id),
      priceHistory: app.products.priceHistory(id, 20),
      movements: app.inventory.movementsFor(id, 30),
    };
  });

  route('POST', '/api/admin/products', (context) => {
    guard(context, 'PRODUCT_MANAGE');
    const body = context.body;
    const product = app.products.create({
      code: str(body.code, 'Urun kodu'),
      name: str(body.name, 'Urun adi'),
      unit: body.unit === 'KG' ? 'KG' : 'EACH',
      unitPrice: money(num(body.unitPrice, 'Fiyat')),
      taxRateBp: num(body.taxRateBp ?? app.config.sales.defaultTaxRateBp, 'KDV') as BasisPoints,
      trackStock: body.trackStock !== false,
      ...(body.stockQty !== undefined
        ? { stockQty: quantity(num(body.stockQty, 'Stok')) }
        : {}),
      ...(Array.isArray(body.barcodes) ? { barcodes: body.barcodes as string[] } : {}),
      ...(Array.isArray(body.plus) ? { plus: (body.plus as number[]).map(Number) } : {}),
    });
    return product;
  });

  route('PUT', '/api/admin/products/:id', (context) => {
    const user = guard(context, 'PRODUCT_MANAGE');
    const id = num(context.params.id, 'id');
    const body = context.body;
    return app.products.update(id, {
      ...(body.name !== undefined ? { name: str(body.name, 'Urun adi') } : {}),
      ...(body.unit !== undefined ? { unit: body.unit === 'KG' ? 'KG' : 'EACH' } : {}),
      ...(body.unitPrice !== undefined
        ? { unitPrice: money(num(body.unitPrice, 'Fiyat')) }
        : {}),
      ...(body.taxRateBp !== undefined
        ? { taxRateBp: num(body.taxRateBp, 'KDV') as BasisPoints }
        : {}),
      ...(body.trackStock !== undefined ? { trackStock: Boolean(body.trackStock) } : {}),
    }, user.id);
  });

  route('POST', '/api/admin/products/:id/active', (context) => {
    guard(context, 'PRODUCT_MANAGE');
    app.products.setActive(num(context.params.id, 'id'), Boolean(context.body.active));
    return { ok: true };
  });

  route('POST', '/api/admin/products/:id/barcodes', (context) => {
    guard(context, 'PRODUCT_MANAGE');
    const id = num(context.params.id, 'id');
    app.db.tx(() => app.products.addBarcode(id, str(context.body.barcode, 'Barkod')));
    return { barcodes: app.products.barcodesFor(id) };
  });

  route('DELETE', '/api/admin/products/:id/barcodes/:barcode', (context) => {
    guard(context, 'PRODUCT_MANAGE');
    const id = num(context.params.id, 'id');
    app.db.tx(() => app.products.removeBarcode(id, context.params.barcode ?? ''));
    return { barcodes: app.products.barcodesFor(id) };
  });

  route('POST', '/api/admin/products/:id/plus', (context) => {
    guard(context, 'PRODUCT_MANAGE');
    const id = num(context.params.id, 'id');
    app.db.tx(() => app.products.addPlu(id, num(context.body.plu, 'PLU')));
    return { plus: app.products.pluListFor(id) };
  });

  route('DELETE', '/api/admin/products/:id/plus/:plu', (context) => {
    guard(context, 'PRODUCT_MANAGE');
    const id = num(context.params.id, 'id');
    app.db.tx(() => app.products.removePlu(id, num(context.params.plu, 'PLU')));
    return { plus: app.products.pluListFor(id) };
  });

  // ============================ STOK ============================

  route('POST', '/api/admin/stock/adjust', (context) => {
    const user = guard(context, 'STOCK_ADJUST');
    const movement = app.inventory.adjust({
      productId: num(context.body.productId, 'Urun'),
      delta: quantity(num(context.body.delta, 'Miktar')),
      type: (context.body.type as MovementType) ?? 'ADJUSTMENT',
      userId: user.id,
      ...(context.body.note !== undefined ? { note: String(context.body.note) } : {}),
    });
    return movement;
  });

  route('POST', '/api/admin/stock/count', (context) => {
    const user = guard(context, 'STOCK_ADJUST');
    return app.inventory.setCount(
      num(context.body.productId, 'Urun'),
      quantity(num(context.body.countedQty, 'Sayilan')) as Quantity,
      user.id,
      context.body.note === undefined ? undefined : String(context.body.note),
    );
  });

  route('GET', '/api/admin/stock/verify', (context) => {
    guard(context, 'STOCK_ADJUST');
    return app.inventory.verify();
  });

  route('POST', '/api/admin/stock/rebuild', (context) => {
    guard(context, 'STOCK_ADJUST');
    return { updated: app.inventory.rebuild() };
  });

  // ============================ KULLANICILAR ============================

  route('GET', '/api/admin/users', (context) => {
    guard(context, 'USER_MANAGE');
    return app.users.list();
  });

  route('POST', '/api/admin/users', (context) => {
    guard(context, 'USER_MANAGE');
    const body = context.body;
    return app.users.create({
      username: str(body.username, 'Kullanici adi'),
      displayName: str(body.displayName, 'Ad soyad'),
      pin: str(body.pin, 'PIN'),
      role: (['CASHIER', 'MANAGER', 'ADMIN'].includes(String(body.role))
        ? String(body.role)
        : 'CASHIER') as Role,
    });
  });

  route('POST', '/api/admin/users/:id/active', (context) => {
    const user = guard(context, 'USER_MANAGE');
    const id = num(context.params.id, 'id');
    if (id === user.id && context.body.active === false) {
      throw new PosError('UNAUTHORIZED', 'Kendi hesabinizi kapatamazsiniz', {
        userMessage: 'Kendi hesabinizi pasife alamazsiniz.',
      });
    }
    app.users.setActive(id, Boolean(context.body.active));
    return { ok: true };
  });

  route('POST', '/api/admin/users/:id/pin', (context) => {
    guard(context, 'USER_MANAGE');
    app.users.changePin(num(context.params.id, 'id'), str(context.body.pin, 'PIN'));
    return { ok: true };
  });

  // ============================ SATIS GECMISI / IADE ============================

  route('GET', '/api/admin/sales', (context) => {
    guard(context, 'REPORT_VIEW');
    const params = context.url.searchParams;
    return reports.salesHistory({
      ...(params.get('date') !== null ? { businessDate: params.get('date')! } : {}),
      ...(params.get('type') !== null
        ? { docType: params.get('type') as 'SALE' | 'REFUND' }
        : {}),
      limit: Number(params.get('limit') ?? 100),
    });
  });

  // ============================ KASA OTURUMLARI ============================

  route('GET', '/api/admin/cash/sessions', (context) => {
    guard(context, 'REPORT_VIEW');
    return app.cashRegister.history(app.terminalId, 60);
  });

  route('GET', '/api/admin/cash/sessions/:id', (context) => {
    guard(context, 'REPORT_VIEW');
    return app.cashRegister.summary(num(context.params.id, 'id'));
  });

  route('POST', '/api/admin/cash/sessions/:id/print', (context) => {
    const user = guard(context, 'REPORT_Z');
    const id = num(context.params.id, 'id');
    const kind = context.body.kind === 'X_REPORT' ? 'X_REPORT' : 'Z_REPORT';
    const jobId = app.printQueue.enqueueDocument(
      app.buildSessionReportDocument(id, kind), { requestedBy: user.id },
    );
    void app.printQueue.processDue();
    return { jobId };
  });

  // ============================ RAPORLAR ============================

  route('GET', '/api/admin/reports/daily', (context) => {
    guard(context, 'REPORT_VIEW');
    return reports.daily(context.url.searchParams.get('date') ?? todayOf(app));
  });

  route('GET', '/api/admin/reports/range', (context) => {
    guard(context, 'REPORT_VIEW');
    const params = context.url.searchParams;
    const to = params.get('to') ?? todayOf(app);
    const from = params.get('from') ?? to;
    return reports.range(from, to);
  });

  route('GET', '/api/admin/reports/top', (context) => {
    guard(context, 'REPORT_VIEW');
    const params = context.url.searchParams;
    const to = params.get('to') ?? todayOf(app);
    const from = params.get('from') ?? to;
    return reports.topProducts(from, to, Number(params.get('limit') ?? 25));
  });

  route('GET', '/api/admin/diagnostics', (context) => {
    guard(context, 'REPORT_VIEW');
    return {
      database: app.db.integrityCheck(),
      audit: verifyAuditChain(app.db),
      stock: app.inventory.verify(),
      printQueue: {
        pending: app.printQueue.pendingCount(),
        failed: app.printQueue.failedCount(),
      },
      scanner: app.devices.scanner.status(),
      weightedFormatConfirmed: app.barcodeConfig.weightedFormatConfirmed,
      simulatedDevices: app.devices.simulated,
    };
  });

  // ============================ YAZICI AYARLARI ============================

  route('GET', '/api/admin/printer/settings', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    return {
      ...app.config.devices.printer,
      deviceName: app.devices.printer.name,
      codePageCandidates: CODE_PAGE_CANDIDATES,
    };
  });

  route('PUT', '/api/admin/printer/settings', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const file = readJsonFile<Record<string, any>>(configFiles.posConfigFile);
    const printer = file.devices.printer as Record<string, unknown>;
    const body = context.body;
    if (body.adapter !== undefined) printer.adapter = String(body.adapter);
    if (body.share !== undefined) printer.share = String(body.share);
    if (body.codePage !== undefined) printer.codePage = String(body.codePage);
    if (body.charactersPerLine !== undefined) {
      printer.charactersPerLine = num(body.charactersPerLine, 'Satir genisligi');
    }
    if (body.openDrawerOnCash !== undefined) {
      printer.openDrawerOnCash = Boolean(body.openDrawerOnCash);
    }
    if (typeof body.tcp === 'object' && body.tcp !== null) {
      const tcp = body.tcp as { host?: string; port?: number };
      printer.tcp = {
        host: String(tcp.host ?? ''),
        port: num(tcp.port ?? 9100, 'Port'),
      };
    }
    writeJsonFile(configFiles.posConfigFile, file);
    return { ok: true, restartRequired: true };
  });

  route('POST', '/api/admin/printer/test', (context) => {
    const user = guard(context, 'SETTINGS_MANAGE');
    const jobId = app.printQueue.enqueueDocument({
      kind: 'TEST',
      storeName: app.config.store.name,
      storeLines: app.config.store.addressLines,
      title: 'YAZICI TEST FISI',
      meta: [
        { label: 'Tarih', value: new Date(app.clock.now()).toLocaleString('tr-TR') },
        { label: 'Kasa', value: app.config.terminal.name },
        { label: 'Yazici', value: app.devices.printer.name },
      ],
      lines: [
        { name: 'Turkce test: sigla CÖĞÜŞİ', detail: '1,000 kg x 100,00', amount: '100,00' },
        { name: 'Ikinci satir', detail: '', amount: '9,90' },
      ],
      totals: [{ label: 'TOPLAM', value: '109,90', emphasize: true }],
      taxRows: [{ label: 'KDV %1', base: '108,81', tax: '1,09' }],
      payments: [{ label: 'NAKIT', value: '110,00' }],
      footer: ['Test tamamlandi'],
      copy: false,
    }, { requestedBy: user.id });
    void app.printQueue.processDue();
    return { jobId };
  });

  route('POST', '/api/admin/printer/codepage-test', async (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const bytes = renderCodePageTest(
      CODE_PAGE_CANDIDATES, app.config.devices.printer.charactersPerLine,
    );
    await app.devices.printer.write(bytes);
    return { ok: true, candidates: CODE_PAGE_CANDIDATES };
  });

  route('GET', '/api/admin/printer/status', async (context) => {
    guard(context, 'REPORT_VIEW');
    return app.devices.printer.status();
  });

  // ============================ MAGAZA AYARLARI ============================

  route('GET', '/api/admin/settings/store', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    return {
      store: app.config.store,
      terminal: app.config.terminal,
      sales: app.config.sales,
      permissions: app.config.permissions,
    };
  });

  route('PUT', '/api/admin/settings/store', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const file = readJsonFile<Record<string, any>>(configFiles.posConfigFile);
    const body = context.body;
    if (typeof body.store === 'object' && body.store !== null) {
      file.store = { ...file.store, ...(body.store as object) };
    }
    if (typeof body.terminal === 'object' && body.terminal !== null) {
      file.terminal = { ...file.terminal, ...(body.terminal as object) };
    }
    if (typeof body.sales === 'object' && body.sales !== null) {
      file.sales = { ...file.sales, ...(body.sales as object) };
    }
    if (typeof body.permissions === 'object' && body.permissions !== null) {
      file.permissions = { ...file.permissions, ...(body.permissions as object) };
    }
    writeJsonFile(configFiles.posConfigFile, file);
    return { ok: true, restartRequired: true };
  });

  // ============================ TERAZI BARKOD KALIBRASYONU ============================

  route('GET', '/api/admin/barcode/rules', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    return {
      weightedFormatConfirmed: app.barcodeConfig.weightedFormatConfirmed,
      rules: app.barcodeConfig.rules,
      limits: app.barcodeConfig.limits,
    };
  });

  route('GET', '/api/admin/barcode/samples', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    return app.db.all<{ raw: string; n: number; last: number; result: string }>(
      `SELECT raw, COUNT(*) AS n, MAX(at) AS last, result
         FROM scan_log WHERE result IN ('UNKNOWN','INVALID')
        GROUP BY raw, result ORDER BY last DESC LIMIT 200`,
    );
  });

  route('POST', '/api/admin/barcode/try', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const code = str(context.body.code, 'Barkod');
    const parsed = app.resolver.parser.parse(code);
    try {
      const item = app.resolver.resolve(code, { terminalId: app.terminalId });
      return {
        parsed,
        resolved: {
          productId: item.product.id,
          productName: item.product.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: item.fixedGross ?? Math.round((item.quantity * item.unitPrice) / 1000),
          priceSource: item.priceSource,
        },
      };
    } catch (error) {
      return {
        parsed,
        resolved: null,
        error: error instanceof PosError ? error.toJSON() : { message: String(error) },
      };
    }
  });

  route('POST', '/api/admin/barcode/analyze', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const body = context.body;
    const stored = app.db.all<{ raw: string }>(
      `SELECT DISTINCT raw FROM scan_log
        WHERE result IN ('UNKNOWN','INVALID') AND raw GLOB '[0-9]*'
        ORDER BY at DESC LIMIT 500`,
    );
    const samples: BarcodeSample[] = stored.map((r) => ({ raw: r.raw }));

    // Kasiyerin/yoneticinin elle girdigi "bu etikette su yaziyor" bilgisi en guclu kanittir
    for (const entry of (Array.isArray(body.samples) ? body.samples : []) as Record<string, unknown>[]) {
      const raw = typeof entry.raw === 'string' ? entry.raw : '';
      if (raw === '') continue;
      samples.push({
        raw,
        ...(entry.knownWeightMilli !== undefined
          ? { knownWeightMilli: num(entry.knownWeightMilli, 'Agirlik') }
          : {}),
        ...(entry.knownPriceKurus !== undefined
          ? { knownPriceKurus: num(entry.knownPriceKurus, 'Tutar') }
          : {}),
        ...(entry.knownPlu !== undefined ? { knownPlu: num(entry.knownPlu, 'PLU') } : {}),
      });
    }

    if (samples.length === 0) {
      return { candidates: [], sampleCount: 0 };
    }
    const candidates = analyzeSamples(samples, { knownPlus: app.products.allPlus() });
    return {
      sampleCount: samples.length,
      candidates: candidates.slice(0, 6).map((c) => ({
        rule: c.rule,
        score: c.score,
        confidence: c.confidence,
        evidence: c.evidence,
        preview: c.decoded.slice(0, 4),
      })),
    };
  });

  route('POST', '/api/admin/barcode/apply', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const rule = context.body.rule as WeightedBarcodeRule | undefined;
    if (rule === undefined || typeof rule.id !== 'string') {
      throw new PosError('CONFIG_ERROR', 'Kural gonderilmedi', {
        userMessage: 'Uygulanacak kural secilmedi.',
      });
    }
    const enabled: WeightedBarcodeRule = { ...rule, enabled: true, priority: 1 };

    const file = readJsonFile<{
      rules: WeightedBarcodeRule[]; weightedFormatConfirmed: boolean;
      minPlainLength: number; maxPlainLength: number;
      limits: { maxWeightMilli: number; maxPriceKurus: number; minPriceKurus: number };
    }>(configFiles.barcodeConfigFile);

    const next = {
      ...file,
      weightedFormatConfirmed: true,
      rules: [enabled, ...file.rules.filter((r) => r.id !== enabled.id)],
    };
    // Bozuk kural yazip kasayi acilamaz hale getirmeyelim
    validateConfig(next);
    writeJsonFile(configFiles.barcodeConfigFile, next);

    app.db.tx(() => {
      app.audit.record({
        type: 'BARCODE_CONFIG_CHANGED',
        userId: context.session?.user.id,
        terminalId: app.terminalId,
        entity: 'barcode_rule',
        entityId: enabled.id,
        data: { rule: enabled as unknown as Record<string, unknown> },
      });
    });
    return { ok: true, restartRequired: true, ruleId: enabled.id };
  });

  route('POST', '/api/admin/barcode/disable', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const file = readJsonFile<Record<string, any>>(configFiles.barcodeConfigFile);
    file.weightedFormatConfirmed = false;
    file.rules = (file.rules as WeightedBarcodeRule[]).map((r) => ({ ...r, enabled: false }));
    writeJsonFile(configFiles.barcodeConfigFile, file);
    return { ok: true, restartRequired: true };
  });

  // ============================ TERAZI PLU DISA AKTARIM ============================

  route('POST', '/api/admin/scale/export', async (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const items: ScalePluItem[] = [];
    for (const product of app.products.list({ activeOnly: true, limit: 20000 })) {
      for (const plu of app.products.pluListFor(product.id)) {
        items.push({
          plu,
          name: product.name,
          unitPrice: product.unitPrice,
          unit: product.unit,
          departmentNo: app.config.devices.scale.departmentNo,
          taxRateBp: product.taxRateBp,
        });
      }
    }
    const result = await app.devices.scale.syncItems(items);
    return result;
  });

  // ============================ DONANIM KURULUM SIHIRBAZI ============================
  //
  // Amac: Windows kurulumundan sonra magazadaki kisinin hicbir teknik bilgi
  // olmadan donanimi calisir hale getirmesi. Kesif "tahmin"dir; her adim
  // GERCEK bir testle dogrulanir (fis basar, barkod okutulur).

  route('GET', '/api/admin/hardware/status', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const hardware = app.config.hardware;
    return {
      setupCompleted: hardware.setupCompletedAt !== null,
      completedAt: hardware.setupCompletedAt,
      scanner: {
        verifiedAt: hardware.scannerVerifiedAt,
        adapter: app.config.devices.scanner.adapter,
        state: app.devices.scanner.status(),
      },
      printer: {
        verifiedAt: hardware.printerVerifiedAt,
        adapter: app.config.devices.printer.adapter,
        deviceName: app.devices.printer.name,
        share: app.config.devices.printer.share,
        tcp: app.config.devices.printer.tcp,
        codePage: app.config.devices.printer.codePage,
      },
      scale: {
        // CAS CL3000 POS'a BAGLANMAZ: etiket basar, kasa o etiketi okur.
        // Bu yuzden cihaz baglantisi istenmez; tek gereken barkod kalibrasyonudur.
        requiresConnection: false,
        calibratedAt: hardware.scaleCalibratedAt,
        weightedFormatConfirmed: app.barcodeConfig.weightedFormatConfirmed,
      },
      platform: process.platform,
    };
  });

  /** Windows yazicilarini listeler (kurulu surucu uzerinden) */
  route('GET', '/api/admin/hardware/printers', async (context) => {
    guard(context, 'SETTINGS_MANAGE');
    return listWindowsPrinters();
  });

  /** Yerel agda RAW 9100 portundan yanit veren cihazlari arar */
  route('POST', '/api/admin/hardware/printers/scan-network', async (context) => {
    guard(context, 'SETTINGS_MANAGE');
    return scanNetworkPrinters({
      ...(context.body.subnet !== undefined ? { subnet: String(context.body.subnet) } : {}),
      timeoutMs: 400,
    });
  });

  /** Barkod okuyucu adaylari (HID) ve seri portlar */
  route('GET', '/api/admin/hardware/scanners', async (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const [hid, serial] = await Promise.all([listHidCandidates(), listSerialPorts()]);
    return {
      hid,
      serialPorts: serial.ports,
      serialSupported: serial.supported,
      currentAdapter: app.config.devices.scanner.adapter,
      // HID okuyucu isletim sistemine KLAVYE olarak gorunur; kesin dogrulama
      // ancak gercek bir barkod okutarak yapilabilir.
      note: 'Kesin dogrulama icin bir barkod okutun.',
    };
  });

  /**
   * Okuyucu testi: gelen ham diziyi cozumler ve NE ANLADIGINI dondurur.
   * Satisa dokunmaz, fis olusturmaz.
   */
  route('POST', '/api/admin/hardware/scanner/test', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const raw = str(context.body.raw, 'Barkod');
    const parsed = app.resolver.parser.parse(raw);
    let product: { name: string; code: string } | null = null;
    if (parsed.kind === 'PLAIN') {
      const hit = app.products.findByBarcode(parsed.normalized);
      if (hit !== undefined) product = { name: hit.product.name, code: hit.product.code };
    }
    return {
      raw,
      normalized: parsed.kind === 'EMPTY' ? '' : parsed.normalized,
      kind: parsed.kind,
      length: parsed.kind === 'EMPTY' ? 0 : parsed.normalized.length,
      product,
      ...(parsed.kind === 'WEIGHTED'
        ? { itemCode: parsed.itemCode, valueKind: parsed.valueKind, value: parsed.value }
        : {}),
      ...(parsed.kind === 'INVALID' ? { reason: parsed.reason } : {}),
    };
  });

  route('POST', '/api/admin/hardware/scanner/confirm', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    patchConfig((file) => {
      file.hardware = file.hardware ?? {};
      file.hardware.scannerVerifiedAt = new Date(app.clock.now()).toISOString();
      file.devices.scanner.adapter =
        typeof context.body.adapter === 'string' && context.body.adapter !== ''
          ? context.body.adapter : 'HID_WEDGE';
      if (typeof context.body.serialPort === 'string' && context.body.serialPort !== '') {
        file.devices.scanner.serial.port = context.body.serialPort;
      }
    });
    return { ok: true };
  });

  /** Yazici secimi: gerekirse paylasima acar, ayari yazar */
  route('POST', '/api/admin/hardware/printer/select', async (context) => {
    guard(context, 'SETTINGS_MANAGE');
    const mode = str(context.body.mode, 'Baglanti tipi');
    const warnings: string[] = [];

    if (mode === 'WINDOWS_SHARE') {
      const printerName = str(context.body.printerName, 'Yazici adi');
      let sharePath = typeof context.body.sharePath === 'string' && context.body.sharePath !== ''
        ? context.body.sharePath : null;
      if (sharePath === null) {
        // Ham bayt gonderebilmek icin yazicinin yerel paylasimda olmasi gerekir
        const shared = await shareWindowsPrinter(
          printerName, printerName.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'POSPRINTER',
        );
        if (shared.ok && shared.sharePath !== undefined) {
          sharePath = shared.sharePath;
        } else {
          throw new PosError('DEVICE_UNAVAILABLE', shared.error ?? 'Paylasim acilamadi', {
            userMessage:
              'Yazici paylasima acilamadi. Uygulamayi yonetici olarak calistirin veya ' +
              'Windows > Yazicilar > (yazici) > Yazici ozellikleri > Paylasim adimini elle yapin.',
          });
        }
      }
      patchConfig((file) => {
        file.devices.printer.adapter = 'WINDOWS_SHARE';
        file.devices.printer.share = sharePath;
      });
      return { ok: true, adapter: 'WINDOWS_SHARE', share: sharePath, warnings, restartRequired: true };
    }

    if (mode === 'TCP') {
      const host = str(context.body.host, 'IP adresi');
      const port = num(context.body.port ?? 9100, 'Port');
      patchConfig((file) => {
        file.devices.printer.adapter = 'TCP';
        file.devices.printer.tcp = { host, port };
      });
      return { ok: true, adapter: 'TCP', host, port, warnings, restartRequired: true };
    }

    throw new PosError('CONFIG_ERROR', `Bilinmeyen baglanti tipi: ${mode}`, {
      userMessage: 'Gecersiz yazici baglanti tipi.',
    });
  });

  route('POST', '/api/admin/hardware/printer/confirm', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    patchConfig((file) => {
      file.hardware = file.hardware ?? {};
      file.hardware.printerVerifiedAt = new Date(app.clock.now()).toISOString();
      if (typeof context.body.codePage === 'string' && context.body.codePage !== '') {
        file.devices.printer.codePage = context.body.codePage;
      }
    });
    return { ok: true };
  });

  route('POST', '/api/admin/hardware/complete', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    patchConfig((file) => {
      file.hardware = file.hardware ?? {};
      file.hardware.setupCompletedAt = new Date(app.clock.now()).toISOString();
      if (app.barcodeConfig.weightedFormatConfirmed) {
        file.hardware.scaleCalibratedAt = new Date(app.clock.now()).toISOString();
      }
    });
    app.db.tx(() => {
      app.audit.record({
        type: 'BARCODE_CONFIG_CHANGED',
        userId: context.session?.user.id,
        terminalId: app.terminalId,
        entity: 'hardware',
        data: { action: 'hardware.setup.completed' },
      });
    });
    return { ok: true, restartRequired: true };
  });

  // ============================ MERKEZI SUNUCU (SYNC) ============================

  route('GET', '/api/admin/sync/status', (context) => {
    guard(context, 'REPORT_VIEW');
    return {
      ...app.sync.status(),
      configured: app.config.sync.enabled,
      defaultServerUrl: app.config.sync.serverUrl,
      terminalCode: app.config.terminal.code,
      counts: app.outbox.counts(),
      recentPulls: app.db.all(
        `SELECT entity_type, entity_id, operation, applied, detail, at
           FROM sync_pull_log ORDER BY id DESC LIMIT 20`,
      ),
      deadEvents: app.db.all(
        `SELECT event_id, type, attempts, last_error, occurred_at
           FROM outbox_events WHERE status IN ('DEAD','FAILED')
          ORDER BY id DESC LIMIT 20`,
      ),
    };
  });

  route('POST', '/api/admin/sync/enroll', async (context) => {
    guard(context, 'SETTINGS_MANAGE');
    // Tek merkezi sunucu vardir; adres ayar dosyasindan gelir, kullanicidan
    // istenmez. Kasa kodu da ilk kurulumda belirlenmistir.
    const serverUrl = (typeof context.body.serverUrl === 'string' && context.body.serverUrl !== ''
      ? context.body.serverUrl
      : app.config.sync.serverUrl).trim();
    if (!/^https?:\/\//.test(serverUrl)) {
      throw new PosError('CONFIG_ERROR', `Sunucu adresi tanimli degil: "${serverUrl}"`, {
        userMessage:
          'Merkezi sunucu adresi tanimli degil. Yonetici ayar dosyasindan tanimlamali.',
      });
    }
    const result = await app.sync.enroll({
      serverUrl,
      enrollmentCode: str(context.body.enrollmentCode, 'Aktivasyon kodu'),
      terminalCode: str(context.body.terminalCode ?? app.config.terminal.code, 'Kasa kodu'),
      name: app.config.terminal.name,
    });
    app.db.tx(() => {
      app.audit.record({
        type: 'BARCODE_CONFIG_CHANGED',
        userId: context.session?.user.id,
        terminalId: app.terminalId,
        entity: 'sync',
        entityId: result.terminalId,
        data: { action: 'terminal.enrolled', serverUrl, storeName: result.storeName },
      });
    });
    // Kayit sonrasi ilk senkronizasyonu hemen tetikle (bootstrap)
    void app.sync.runOnce();
    if (app.config.sync.enabled) app.sync.start();
    pushState();
    return { ok: true, storeName: result.storeName, terminalId: result.terminalId };
  });

  route('POST', '/api/admin/sync/now', async (context) => {
    guard(context, 'REPORT_VIEW');
    const status = await app.sync.runOnce();
    pushState();
    return status;
  });

  route('POST', '/api/admin/sync/retry-dead', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    return { retried: app.sync.retryFailed() };
  });

  route('POST', '/api/admin/sync/unenroll', (context) => {
    guard(context, 'SETTINGS_MANAGE');
    app.sync.unenroll();
    pushState();
    return { ok: true };
  });

  // ============================ BAKIM ============================

  route('POST', '/api/admin/maintenance/print-retry', (context) => {
    guard(context, 'REPORT_VIEW');
    const retried = app.printQueue.retryFailed();
    void app.printQueue.processDue();
    pushState();
    return { retried };
  });
}
