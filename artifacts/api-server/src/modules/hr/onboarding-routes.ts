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
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { encryptField, last4, isHrKeyConfigured } from "../../shared/hr-crypto";
import {
  CONTRACT_TYPES,
  isValidNationalId,
  isValidEgyptianIban,
  isValidAccountNo,
  normalizeAccountNo,
  normalizeIban,
  contractDatesError,
  isValidSalary,
} from "./onboarding-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMPNO_RE = /^[A-Za-z0-9_-]{1,32}$/;
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
  employee: {
    employeeNo: string;
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

/** Validate the whole onboarding payload. Returns an Arabic error or the typed input. */
export function parseOnboard(body: any): { error: string } | { input: OnboardInput } {
  const employeeNo = str(body?.employee?.employeeNo, 32);
  const fullName = str(body?.employee?.fullName, 200);
  const hireDate = optDate(body?.employee?.hireDate);
  if (!employeeNo || !EMPNO_RE.test(employeeNo) || !fullName || !hireDate) {
    return { error: "رقم الموظف والاسم وتاريخ التعيين مطلوبين" };
  }
  const biometricPin = str(body?.employee?.biometricPin, 32);
  if (biometricPin && !PIN_RE.test(biometricPin)) return { error: "رقم البصمة غير صالح" };

  const nationalId = String(body?.profile?.nationalId ?? "").trim();
  if (!isValidNationalId(nationalId)) return { error: "الرقم القومي يجب أن يكون 14 رقماً" };
  const dob = body?.profile?.dateOfBirth ? optDate(body.profile.dateOfBirth) : null;
  if (body?.profile?.dateOfBirth && !dob) return { error: "تاريخ الميلاد غير صالح" };

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
      employee: {
        employeeNo,
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
  try {
    const result = await db.transaction(async (tx) => {
      const [emp] = await tx
        .insert(hrEmployeesTable)
        .values({
          employeeNo: input.employee.employeeNo,
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
      return emp;
    });
    res.status(201).json({ id: result.id, employeeNo: result.employeeNo });
  } catch (err) {
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

export default router;
