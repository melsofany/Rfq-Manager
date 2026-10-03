// قائمة البنوك العاملة في مصر — تُستخدم لاختيار اسم البنك مع شعاره.
// `domain` يُستخدم لجلب الشعار من خدمة favicons (Google s2)، ويُضبط فقط عند
// التأكد من مطابقته للبنك الصحيح: نطاق خاطئ يعرض شعار بنك آخر — وهذا أسوأ من
// عدم عرض شعار. البنك بلا `domain` يعرض الأحرف الأولى بدلًا من الشعار.
export interface EgyptianBank {
  /** الاسم كما يظهر للمستخدم */
  name: string;
  /** الاسم الإنجليزي (للبحث) */
  nameEn: string;
  /** نطاق الموقع لجلب الشعار */
  domain?: string;
}

export const EGYPTIAN_BANKS: EgyptianBank[] = [
  { name: "البنك الأهلي المصري", nameEn: "National Bank of Egypt", domain: "nbe.com.eg" },
  { name: "بنك مصر", nameEn: "Banque Misr", domain: "banquemisr.com" },
  { name: "بنك القاهرة", nameEn: "Banque du Caire", domain: "bdcegypt.com" },
  {
    name: "البنك التجاري الدولي",
    nameEn: "Commercial International Bank (CIB)",
    domain: "cibeg.com",
  },
  { name: "بنك الإسكندرية", nameEn: "Bank of Alexandria", domain: "alexbank.com" },
  { name: "البنك العربي الأفريقي الدولي", nameEn: "Arab African International Bank" },
  { name: "بنك قناة السويس", nameEn: "Suez Canal Bank", domain: "suezcanalbank.com" },
  { name: "بنك التنمية الصناعية", nameEn: "Industrial Development Bank" },
  { name: "بنك الإسكان والتعمير", nameEn: "Housing and Development Bank" },
  {
    name: "البنك الأهلي الكويتي — مصر",
    nameEn: "Al Ahli Bank of Kuwait Egypt",
    domain: "abkegypt.com",
  },
  { name: "بنك قطر الوطني الأهلي", nameEn: "QNB Alahli", domain: "qnbalahli.com" },
  { name: "بنك الكويت الوطني — مصر", nameEn: "National Bank of Kuwait Egypt", domain: "nbk.com" },
  { name: "بنك عودة", nameEn: "Bank Audi", domain: "bankaudigroup.com" },
  { name: "بنك بيروت", nameEn: "Bank of Beirut", domain: "bankofbeirut.com" },
  {
    name: "البنك المصري لتنمية الصادرات",
    nameEn: "Export Development Bank of Egypt",
    domain: "ebe.com.eg",
  },
  { name: "بنك الاستثمار العربي", nameEn: "Arab Investment Bank", domain: "aibegypt.com" },
  { name: "بنك saib", nameEn: "Société Arabe Internationale de Banque", domain: "saib.com.eg" },
  { name: "بنك مصر إيران للتنمية", nameEn: "Misr Iran Development Bank" },
  { name: "البنك الزراعي المصري", nameEn: "Agricultural Bank of Egypt" },
  { name: "البنك المركزي المصري", nameEn: "Central Bank of Egypt", domain: "cbe.org.eg" },
  { name: "بنك فيصل الإسلامي المصري", nameEn: "Faisal Islamic Bank of Egypt" },
  { name: "بنك البركة مصر", nameEn: "Al Baraka Bank Egypt" },
  {
    name: "بنك أبوظبي التجاري — مصر",
    nameEn: "Abu Dhabi Commercial Bank Egypt",
    domain: "adcb.com",
  },
  { name: "بنك أبوظبي الأول — مصر", nameEn: "First Abu Dhabi Bank Egypt", domain: "bankfab.com" },
  {
    name: "بنك الإمارات دبي الوطني — مصر",
    nameEn: "Emirates NBD Egypt",
    domain: "emiratesnbd.com",
  },
  { name: "بنك المشرق", nameEn: "Mashreq Bank", domain: "mashreq.com" },
  { name: "بنك HSBC — مصر", nameEn: "HSBC Egypt", domain: "hsbc.com.eg" },
  { name: "بنك كريدي أجريكول — مصر", nameEn: "Crédit Agricole Egypt", domain: "ca-egypt.com" },
  { name: "بنك بلوم مصر", nameEn: "Blom Bank Egypt", domain: "blombankegypt.com" },
  { name: "البنك التجاري وفا بنك — مصر", nameEn: "Attijariwafa Bank Egypt" },
  { name: "بنك دبي الإسلامي", nameEn: "Dubai Islamic Bank", domain: "dib.ae" },
  { name: "بنك أبوظبي الإسلامي", nameEn: "Abu Dhabi Islamic Bank", domain: "adib.ae" },
  { name: "البنك العربي", nameEn: "Arab Bank", domain: "arabbank.com" },
  { name: "بنك سيتي بنك — مصر", nameEn: "Citibank Egypt", domain: "citibank.com" },
  { name: "بنك ستاندرد تشارترد", nameEn: "Standard Chartered", domain: "sc.com" },
];

/** شعار البنك (رابط صورة) أو null لعرض الأحرف الأولى */
export function bankLogoUrl(domain?: string): string | null {
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

/** إيجاد البنك بالاسم (مطابقة تامة أو احتواء أحد الاتجاهين) */
export function findBankByName(name: string | null | undefined): EgyptianBank | null {
  if (!name) return null;
  const q = name.trim().toLowerCase();
  if (!q) return null;
  return (
    EGYPTIAN_BANKS.find((b) => b.name.toLowerCase() === q) ??
    EGYPTIAN_BANKS.find(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        q.includes(b.name.toLowerCase()) ||
        b.nameEn.toLowerCase().includes(q),
    ) ??
    null
  );
}

/** الأحرف الأولى لاسم البنك — تُعرض عندما لا يتوفر شعار */
export function bankInitials(name: string): string {
  const words = name.replace(/^ال/, "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2);
  return (words[0][0] ?? "") + (words[1][0] ?? "");
}
