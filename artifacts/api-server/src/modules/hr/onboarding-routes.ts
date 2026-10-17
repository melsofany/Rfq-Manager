/**
 * Hiring and onboarding — تعيين موظف جديد بكامل بياناته.
 *
 *   POST /api/hr/onboard      creates employee + profile + contract + bank account in one transaction
 *   GET  /api/hr/employees/:id/file   masked file: profile, contracts, bank accounts
 *
 * Sensitive values (national ID, account number, IBAN) are encrypted; responses show last 4 digits only.
 */
import { Router, type IRouter } from "express";
import {
  db,
  hrEmployeesTable,
  hrEmployeeProfilesTable,
  hrContractsTable,
  hrBankAccountsTable,
  hrEmployeePhotosTable,
} from "@workspace/db";
import { and, eq, like, sql } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { encryptField, last4, isHrKeyConfigured } from "../../shared/hr-crypto";
import {
  CONTRACT_TYPES,
  isValidNationalId,
  birthDateFromNationalId,
  isValidEgyptianIban,
  isValidAccountNo,
  normalizeAccountNo,
  normalizeIban,
  contractDatesError,
  isValidSalary,
  parsePhoto,
  type ParsedPhoto,
} from "./onboarding-logic";
import { generateEmployeeNo } from "./employee-number";
import { logger } from "../../shared/logger";
import { parseMoney } from "./discipline-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PIN_RE = /^[A-Za-z0-9_-]{1,32}$/;

function str(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}
function optDate(v: unknown): string | null {
  return typeof v === "string" && DATE_RE.test(v) ? v : null;
}

interface OnboardInput {
  photo: ParsedPhoto | null;
  employee: {
    fullName: string;
    jobTitle: string | null;
    department: string | null;
    hireDate: string;
    phone: string | null;
    biometricPin: string | null;
  };
  profile: {
    nationalId: string;
    dateOfBirth: string | null;
    gender: string | null;
    address: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
    socialInsuranceNo: string | null;
    healthInsuranceNo: string | null;
  };
  contract: {
    contractType: string;
    startDate: string;
    endDate: string | null;
    probationEndDate: string | null;
    basicSalary: number;
    allowances: number;
  };
  bank: { bankName: string; accountHolder: string; accountNo: string; iban: string | null };
}

/** Validate the whole onboarding payload. The employee number is generated on save, not sent by the client. */
export function parseOnboard(body: any): { error: string } | { input: OnboardInput } {
  const fullName = str(body?.employee?.fullName, 200);
  const hireDate = optDate(body?.employee?.hireDate);
  if (!fullName || !hireDate) {
    return { error: "الاسم وتاريخ التعيين مطلوبين" };
  }
  const biometricPin = str(body?.employee?.biometricPin, 32);
  if (biometricPin && !PIN_RE.test(biometricPin)) return { error: "رقم البصمة غير صالح" };

  const nationalId = String(body?.profile?.nationalId ?? "").trim();
  if (!isValidNationalId(nationalId)) return { error: "الرقم القومي يجب أن يكون 14 رقماً" };
  // Birth date is read from the national ID, never typed by hand.
  const dob = birthDateFromNationalId(nationalId);
  if (!dob) return { error: "تعذّر قراءة تاريخ الميلاد من الرقم القومي، تأكد من الرقم" };
  if (Number(hireDate.slice(0, 4)) - Number(dob.slice(0, 4)) < 14)
    return { error: "تاريخ الميلاد لا يناسب تاريخ التعيين" };

  const photoParsed = parsePhoto(body?.photo);
  if (photoParsed && "error" in photoParsed) return { error: photoParsed.error };

  const contractType = body?.contract?.contractType;
  if (!(CONTRACT_TYPES as readonly string[]).includes(contractType))
    return { error: "نوع العقد غير صالح" };
  const cStart = optDate(body?.contract?.startDate);
  if (!cStart) return { error: "تاريخ بداية العقد مطلوب" };
  const cEnd = body?.contract?.endDate ? optDate(body.contract.endDate) : null;
  const cProb = body?.contract?.probationEndDate ? optDate(body.contract.probationEndDate) : null;
  const dateErr = contractDatesError(contractType, cStart, cEnd, cProb);
  if (dateErr) return { error: dateErr };
  const basicSalary = Number(body?.contract?.basicSalary);
  const allowances = Number(body?.contract?.allowances ?? 0);
  if (!isValidSalary(basicSalary) || !isValidSalary(allowances))
    return { error: "الراتب الأساسي والبدلات أرقام موجبة (حتى منزلتين عشريتين)" };

  const bankName = str(body?.bank?.bankName, 100);
  const accountHolder = str(body?.bank?.accountHolder, 200);
  const accountNoRaw = String(body?.bank?.accountNo ?? "");
  if (!bankName || !accountHolder) return { error: "اسم البنك وصاحب الحساب مطلوبين" };
  if (!isValidAccountNo(accountNoRaw))
    return { error: "رقم الحساب البنكي غير صالح (6 إلى 30 رقماً)" };
  const ibanRaw = body?.bank?.iban ? String(body.bank.iban) : "";
  if (ibanRaw && !isValidEgyptianIban(ibanRaw))
    return { error: "الآيبان المصري غير صالح (EG + 27 رقماً)" };

  return {
    input: {
      photo: photoParsed ? photoParsed.photo : null,
      employee: {
        fullName,
        jobTitle: str(body?.employee?.jobTitle),
        department: str(body?.employee?.department),
        hireDate,
        phone: str(body?.employee?.phone, 40),
        biometricPin,
      },
      profile: {
        nationalId,
        dateOfBirth: dob,
        gender: ["male", "female"].includes(body?.profile?.gender) ? body.profile.gender : null,
        address: str(body?.profile?.address, 500),
        emergencyContactName: str(body?.profile?.emergencyContactName, 200),
        emergencyContactPhone: str(body?.profile?.emergencyContactPhone, 40),
        socialInsuranceNo: str(body?.profile?.socialInsuranceNo, 40),
        healthInsuranceNo: str(body?.profile?.healthInsuranceNo, 40),
      },
      contract: {
        contractType,
        startDate: cStart,
        endDate: cEnd,
        probationEndDate: cProb,
        basicSalary,
        allowances,
      },
      bank: {
        bankName,
        accountHolder,
        accountNo: normalizeAccountNo(accountNoRaw),
        iban: ibanRaw ? normalizeIban(ibanRaw) : null,
      },
    },
  };
}

class OnboardRejected extends Error {}

router.post("/hr/onboard", async (req, res): Promise<void> => {
  if (!isHrKeyConfigured()) {
    res
      .status(503)
      .json({ error: "مفتاح تشفير بيانات الموظفين (HR_DATA_KEY) غير مضبوط على السيرفر" });
    return;
  }
  const parsed = parseOnboard(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { input } = parsed;
  const hireYear = Number(input.employee.hireDate.slice(0, 4));
  const birthYear = Number(input.profile.dateOfBirth!.slice(0, 4));
  try {
    const result = await db.transaction(async (tx) => {
      // Serialize number generation so two hires at once cannot take the same sequence.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hr_employee_no'))`);
      const existing = await tx
        .select({ no: hrEmployeesTable.employeeNo })
        .from(hrEmployeesTable)
        .where(like(hrEmployeesTable.employeeNo, `${String(hireYear % 100).padStart(2, "0")}%`));
      const gen = generateEmployeeNo(
        hireYear,
        birthYear,
        existing.map((r) => r.no),
      );
      if ("error" in gen) throw new OnboardRejected(gen.error);

      const [emp] = await tx
        .insert(hrEmployeesTable)
        .values({
          employeeNo: gen.employeeNo,
          fullName: input.employee.fullName,
          jobTitle: input.employee.jobTitle,
          department: input.employee.department,
          hireDate: input.employee.hireDate,
          phone: input.employee.phone,
          biometricPin: input.employee.biometricPin,
          status: "active",
        })
        .returning();
      await tx.insert(hrEmployeeProfilesTable).values({
        employeeId: emp.id,
        nationalIdEnc: encryptField(input.profile.nationalId),
        nationalIdLast4: last4(input.profile.nationalId),
        dateOfBirth: input.profile.dateOfBirth,
        gender: input.profile.gender,
        address: input.profile.address,
        emergencyContactName: input.profile.emergencyContactName,
        emergencyContactPhone: input.profile.emergencyContactPhone,
        socialInsuranceNo: input.profile.socialInsuranceNo,
        healthInsuranceNo: input.profile.healthInsuranceNo,
      });
      await tx.insert(hrContractsTable).values({
        employeeId: emp.id,
        contractType: input.contract.contractType,
        startDate: input.contract.startDate,
        endDate: input.contract.endDate,
        probationEndDate: input.contract.probationEndDate,
        basicSalary: String(input.contract.basicSalary),
        allowances: String(input.contract.allowances),
        isCurrent: true,
      });
      await tx.insert(hrBankAccountsTable).values({
        employeeId: emp.id,
        bankName: input.bank.bankName,
        accountHolder: input.bank.accountHolder,
        accountNoEnc: encryptField(input.bank.accountNo),
        accountLast4: last4(input.bank.accountNo),
        ibanEnc: input.bank.iban ? encryptField(input.bank.iban) : null,
        ibanLast4: input.bank.iban ? last4(input.bank.iban) : null,
        isPrimary: true,
      });
      if (input.photo) {
        await tx.insert(hrEmployeePhotosTable).values({
          employeeId: emp.id,
          mimeType: input.photo.mime,
          dataB64: input.photo.data,
        });
      }
      return emp;
    });
    res.status(201).json({ id: result.id, employeeNo: result.employeeNo });
  } catch (err) {
    if (err instanceof OnboardRejected) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (String((err as Error)?.message).includes("unique")) {
      res.status(409).json({ error: "رقم الموظف أو البصمة مستخدم بالفعل" });
      return;
    }
    throw err;
  }
});

router.get("/hr/employees/:id/file", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const [emp] = await db
    .select()
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, id))
    .limit(1);
  if (!emp) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  const [profile] = await db
    .select()
    .from(hrEmployeeProfilesTable)
    .where(eq(hrEmployeeProfilesTable.employeeId, id))
    .limit(1);
  const contracts = await db
    .select()
    .from(hrContractsTable)
    .where(eq(hrContractsTable.employeeId, id));
  const banks = await db
    .select()
    .from(hrBankAccountsTable)
    .where(eq(hrBankAccountsTable.employeeId, id));
  res.json({
    employee: emp,
    profile: profile
      ? {
          nationalIdMasked: profile.nationalIdLast4
            ? `•••••••••••${profile.nationalIdLast4}`
            : null,
          dateOfBirth: profile.dateOfBirth,
          gender: profile.gender,
          address: profile.address,
          emergencyContactName: profile.emergencyContactName,
          emergencyContactPhone: profile.emergencyContactPhone,
          socialInsuranceNo: profile.socialInsuranceNo,
          healthInsuranceNo: profile.healthInsuranceNo,
        }
      : null,
    contracts,
    bankAccounts: banks.map((b) => ({
      id: b.id,
      bankName: b.bankName,
      accountHolder: b.accountHolder,
      accountMasked: `•••• ${b.accountLast4}`,
      ibanMasked: b.ibanLast4 ? `•••• ${b.ibanLast4}` : null,
      isPrimary: b.isPrimary,
    })),
  });
});

/**
 * PUT /hr/employees/:id/bank — تعديل الحساب البنكي الأساسي (مرتب التحويل).
 * بيحدّث الحساب الأساسي، ولو مفيش حساب بيضيفه. الأرقام بتتشفر زي التعيين.
 */
router.put("/hr/employees/:id/bank", async (req, res): Promise<void> => {
  if (!isHrKeyConfigured()) {
    res
      .status(503)
      .json({ error: "مفتاح تشفير بيانات الموظفين (HR_DATA_KEY) غير مضبوط على السيرفر" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const bankName = str(req.body?.bankName, 100);
  const accountHolder = str(req.body?.accountHolder, 200);
  const accountNoRaw = String(req.body?.accountNo ?? "");
  if (!bankName || !accountHolder) {
    res.status(400).json({ error: "اسم البنك وصاحب الحساب مطلوبين" });
    return;
  }
  if (!isValidAccountNo(accountNoRaw)) {
    res.status(400).json({ error: "رقم الحساب البنكي غير صالح (6 إلى 30 رقماً)" });
    return;
  }
  const ibanRaw = req.body?.iban ? String(req.body.iban) : "";
  if (ibanRaw && !isValidEgyptianIban(ibanRaw)) {
    res.status(400).json({ error: "الآيبان المصري غير صالح (EG + 27 رقماً)" });
    return;
  }
  const accountNo = normalizeAccountNo(accountNoRaw);
  const iban = ibanRaw ? normalizeIban(ibanRaw) : null;
  const values = {
    bankName,
    accountHolder,
    accountNoEnc: encryptField(accountNo),
    accountLast4: last4(accountNo),
    ibanEnc: iban ? encryptField(iban) : null,
    ibanLast4: iban ? last4(iban) : null,
  };
  const [emp] = await db
    .select({ id: hrEmployeesTable.id })
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, id))
    .limit(1);
  if (!emp) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  await db.transaction(async (tx) => {
    const [primary] = await tx
      .select({ id: hrBankAccountsTable.id })
      .from(hrBankAccountsTable)
      .where(and(eq(hrBankAccountsTable.employeeId, id), eq(hrBankAccountsTable.isPrimary, true)))
      .limit(1);
    if (primary) {
      await tx
        .update(hrBankAccountsTable)
        .set(values)
        .where(eq(hrBankAccountsTable.id, primary.id));
    } else {
      await tx.insert(hrBankAccountsTable).values({ ...values, employeeId: id, isPrimary: true });
    }
  });
  res.json({ ok: true });
});

/**
 * PUT /hr/employees/:id/salary — تعديل الراتب الأساسي والحافز على العقد الحالي.
 * Body: { basicSalary, incentive }. Past payroll months keep their own snapshot.
 */
router.put("/hr/employees/:id/salary", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const basic = parseMoney(req.body?.basicSalary);
  const incentive = parseMoney(req.body?.incentive);
  if (basic === null || basic <= 0) {
    res.status(400).json({ error: "الراتب الأساسي يجب أن يكون أكبر من صفر" });
    return;
  }
  if (incentive === null) {
    res.status(400).json({ error: "الحافز يجب أن يكون رقماً موجباً أو صفر" });
    return;
  }
  const [current] = await db
    .select({ id: hrContractsTable.id })
    .from(hrContractsTable)
    .where(and(eq(hrContractsTable.employeeId, id), eq(hrContractsTable.isCurrent, true)))
    .limit(1);
  if (!current) {
    res.status(409).json({ error: "لا يوجد عقد حالي للموظف" });
    return;
  }
  await db
    .update(hrContractsTable)
    .set({ basicSalary: String(basic), incentive: String(incentive) })
    .where(eq(hrContractsTable.id, current.id));
  logger.info({ employeeId: id, basic, incentive }, "hr: salary updated");
  res.json({ ok: true, basicSalary: basic, incentive });
});

/** Employee photo: GET returns the image bytes; PUT replaces it (JSON body { photo: dataUrl }). */
/**
 * PUT /hr/employees/:id/national-id — تعديل الرقم القومي (مشفّر، بيظهر آخر 4 أرقام بس).
 */
router.put("/hr/employees/:id/national-id", async (req, res): Promise<void> => {
  if (!isHrKeyConfigured()) {
    res
      .status(503)
      .json({ error: "مفتاح تشفير بيانات الموظفين (HR_DATA_KEY) غير مضبوط على السيرفر" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const nationalId = String(req.body?.nationalId ?? "").trim();
  if (!isValidNationalId(nationalId)) {
    res.status(400).json({ error: "الرقم القومي يجب أن يكون 14 رقماً" });
    return;
  }
  const [emp] = await db
    .select({ id: hrEmployeesTable.id })
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, id))
    .limit(1);
  if (!emp) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  const dob = birthDateFromNationalId(nationalId);
  if (!dob) {
    res.status(400).json({ error: "تعذّر قراءة تاريخ الميلاد من الرقم القومي، تأكد من الرقم" });
    return;
  }
  const values = {
    nationalIdEnc: encryptField(nationalId),
    nationalIdLast4: last4(nationalId),
    dateOfBirth: dob,
  };
  await db.transaction(async (tx) => {
    const [profile] = await tx
      .select({ employeeId: hrEmployeeProfilesTable.employeeId })
      .from(hrEmployeeProfilesTable)
      .where(eq(hrEmployeeProfilesTable.employeeId, id))
      .limit(1);
    if (profile) {
      await tx
        .update(hrEmployeeProfilesTable)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(hrEmployeeProfilesTable.employeeId, id));
    } else {
      await tx.insert(hrEmployeeProfilesTable).values({ employeeId: id, ...values });
    }
  });
  logger.info({ employeeId: id }, "hr: national ID updated");
  res.json({
    ok: true,
    nationalIdMasked: `•••••••••••${values.nationalIdLast4}`,
    dateOfBirth: dob,
  });
});

router.get("/hr/employees/:id/photo", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const [row] = await db
    .select()
    .from(hrEmployeePhotosTable)
    .where(eq(hrEmployeePhotosTable.employeeId, id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "لا توجد صورة" });
    return;
  }
  res.setHeader("Content-Type", row.mimeType);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(Buffer.from(row.dataB64, "base64"));
});

router.put("/hr/employees/:id/photo", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرف غير صالح" });
    return;
  }
  const parsed = parsePhoto(req.body?.photo);
  if (!parsed || "error" in parsed) {
    res.status(400).json({ error: parsed?.error ?? "الصورة مطلوبة" });
    return;
  }
  const [emp] = await db
    .select({ id: hrEmployeesTable.id })
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, id))
    .limit(1);
  if (!emp) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  await db
    .insert(hrEmployeePhotosTable)
    .values({ employeeId: id, mimeType: parsed.photo.mime, dataB64: parsed.photo.data })
    .onConflictDoUpdate({
      target: hrEmployeePhotosTable.employeeId,
      set: {
        mimeType: parsed.photo.mime,
        dataB64: parsed.photo.data,
        updatedAt: new Date(),
      },
    });
  res.json({ ok: true });
});

export default router;
