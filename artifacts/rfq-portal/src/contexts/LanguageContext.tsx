import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import translations, { type Lang } from "@/i18n/translations";

interface LanguageContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  dir: "ltr" | "rtl";
  isAr: boolean;
}

const LanguageContext = createContext<LanguageContextValue>({
  lang: "en",
  setLang: () => {},
  t: (key) => key,
  dir: "ltr",
  isAr: false,
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const stored = localStorage.getItem("rfq-lang");
      if (stored === "ar" || stored === "en") return stored;
    } catch {}
    return "en";
  });

  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem("rfq-lang", l); } catch {}
  };

  const dir: "ltr" | "rtl" = lang === "ar" ? "rtl" : "ltr";

  // Apply dir to document root
  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = lang;
  }, [dir, lang]);

  const t = (key: string, vars?: Record<string, string | number>): string => {
    const dict = translations[lang];
    let text = dict[key] ?? translations["en"][key] ?? key;
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        text = text.replace(`{${k}}`, String(v));
      });
    }
    return text;
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang, t, dir, isAr: lang === "ar" }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
