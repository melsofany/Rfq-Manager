// قائمة البنوك العاملة في مصر (وفق سجل البنك المركزي المصري) — تُستخدم لاختيار
// اسم البنك مع شعاره.
//
// الشعارات مُجمّعة محليًا في `public/bank-logos/` (لا اعتماد على خدمة خارجية):
// الشعار المستضاف خارجيًا يختفي (404) أو يعرض شعار بنك آخر عند تغيّر النطاق —
// وكلاهما أسوأ من عدم عرض شعار. كل ملف هنا تم التحقق منه (نوع صورة صحيح + ليس
// صورة عامة/بديلة). البنك بلا شعار يعرض الأحرف الأولى.
export interface EgyptianBank {
  /** الاسم كما يظهر للمستخدم */
  name: string;
  /** الاسم الإنجليزي (للبحث) */
  nameEn: string;
  /** اسم ملف الشعار داخل `public/bank-logos` (بدون امتداد) — غيابه = الأحرف الأولى */
  logo?: string;
}

/** امتداد ملف الشعار — يُبنى الرابط كـ `/bank-logos/<logo>.<ext>` */
const LOGO_EXT: Record<string, string> = {
  aaib: "svg",
  bankabc: "svg",
  qnb: "svg",
  abk: "ico",
  albaraka: "ico",
  banquemisr: "ico",
  citibank: "ico",
  idb: "ico",
  theub: "ico",
  banqueducaire: "jpg",
  fab: "jpg",
  creditagricole: "gif",
};

export const EGYPTIAN_BANKS: EgyptianBank[] = [
  // بنوك القطاع العام والبنوك المصرية الكبرى
  { name: "البنك المركزي المصري", nameEn: "Central Bank of Egypt", logo: "cbe" },
  { name: "البنك الأهلي المصري", nameEn: "National Bank of Egypt", logo: "nbe" },
  { name: "بنك مصر", nameEn: "Banque Misr", logo: "banquemisr" },
  { name: "بنك القاهرة", nameEn: "Banque du Caire", logo: "banqueducaire" },
  { name: "بنك الإسكندرية", nameEn: "Bank of Alexandria (AlexBank)", logo: "alexbank" },
  { name: "البنك التجاري الدولي", nameEn: "Commercial International Bank (CIB)", logo: "cib" },
  { name: "بنك قناة السويس", nameEn: "Suez Canal Bank", logo: "scbank" },
  { name: "بنك التعمير والإسكان", nameEn: "Housing and Development Bank", logo: "hdb" },
  { name: "بنك التنمية الصناعية", nameEn: "Industrial Development Bank", logo: "idb" },
  {
    name: "البنك المصري لتنمية الصادرات",
    nameEn: "Export Development Bank of Egypt",
    logo: "ebe",
  },
  { name: "المصرف المتحد", nameEn: "The United Bank", logo: "theub" },
  { name: "ميد بنك", nameEn: "MIDBANK", logo: "midbank" },
  { name: "البنك الزراعي المصري", nameEn: "Agricultural Bank of Egypt" },
  { name: "البنك العقاري المصري العربي", nameEn: "Egyptian Arab Land Bank" },
  { name: "البنك المصري الخليجي", nameEn: "EGBANK", logo: "egbank" },
  { name: "بنك الاستثمار العربي", nameEn: "Arab Investment Bank (AIBANK)" },
  { name: "بنك نكست", nameEn: "Bank NXT" },
  { name: "بنك واحد", nameEn: "onebank" },

  // البنوك الإسلامية
  { name: "بنك فيصل الإسلامي المصري", nameEn: "Faisal Islamic Bank of Egypt", logo: "faisal" },
  { name: "بنك البركة مصر", nameEn: "Al Baraka Bank Egypt", logo: "albaraka" },
  { name: "مصرف أبوظبي الإسلامي — مصر", nameEn: "Abu Dhabi Islamic Bank (ADIB)", logo: "adib" },
  { name: "بيت التمويل الكويتي — مصر", nameEn: "Kuwait Finance House (KFH)", logo: "kfh" },

  // البنوك الأجنبية والفروع العاملة في مصر
  { name: "بنك الإمارات دبي الوطني — مصر", nameEn: "Emirates NBD Egypt", logo: "emiratesnbd" },
  { name: "بنك أبوظبي الأول — مصر", nameEn: "First Abu Dhabi Bank (FAB)", logo: "fab" },
  { name: "بنك أبوظبي التجاري — مصر", nameEn: "Abu Dhabi Commercial Bank (ADCB)", logo: "adcb" },
  { name: "بنك قطر الوطني الأهلي", nameEn: "QNB Egypt", logo: "qnb" },
  { name: "بنك الكويت الوطني — مصر", nameEn: "National Bank of Kuwait (NBK)", logo: "nbk" },
  { name: "البنك الأهلي الكويتي — مصر", nameEn: "Al Ahli Bank of Kuwait (ABK)", logo: "abk" },
  { name: "البنك العربي", nameEn: "Arab Bank", logo: "arabbank" },
  { name: "بنك المؤسسة العربية المصرفية", nameEn: "Bank ABC", logo: "bankabc" },
  { name: "بنك saib", nameEn: "Société Arabe Internationale de Banque (SAIB)", logo: "saib" },
  {
    name: "البنك العربي الأفريقي الدولي",
    nameEn: "Arab African International Bank (AAIB)",
    logo: "aaib",
  },
  {
    name: "البنك التجاري وفا بنك — مصر",
    nameEn: "Attijariwafa Bank Egypt",
    logo: "attijariwafa",
  },
  { name: "بنك كريدي أجريكول — مصر", nameEn: "Crédit Agricole Egypt", logo: "creditagricole" },
  { name: "بنك HSBC — مصر", nameEn: "HSBC Egypt", logo: "hsbc" },
  { name: "بنك سيتي بنك — مصر", nameEn: "Citibank Egypt", logo: "citibank" },
  { name: "بنك المشرق", nameEn: "Mashreq Bank", logo: "mashreq" },
  { name: "بنك ستاندرد تشارترد", nameEn: "Standard Chartered", logo: "standardchartered" },
];

/** شعار البنك (مسار محلي) أو null لعرض الأحرف الأولى */
export function bankLogoUrl(bank: EgyptianBank | null | undefined): string | null {
  if (!bank?.logo) return null;
  const ext = LOGO_EXT[bank.logo] ?? "png";
  return `/bank-logos/${bank.logo}.${ext}`;
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
