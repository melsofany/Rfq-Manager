import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useLogin, getGetMeQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, Languages } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { firstAccessiblePath } from "@/lib/permissions";

export default function LoginPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const { t, lang, setLang } = useLanguage();

  const loginMutation = useLogin({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        // Land on the first page the employee is permitted to view (instead of
        // always /dashboard, which blanks for users without that permission).
        const emp = data?.employee;
        const target = firstAccessiblePath(emp?.role, emp?.permissions) ?? "/no-access";
        navigate(target);
      },
      onError: () => {
        setError(t("login.error"));
      },
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    loginMutation.mutate({ data: { email, password } });
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Language toggle */}
        <div className="flex justify-end mb-4">
          <button
            onClick={() => setLang(lang === "en" ? "ar" : "en")}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border hover:bg-muted transition-colors"
          >
            <Languages size={13} />
            {t("lang.toggle")}
          </button>
        </div>
        <div className="text-center mb-8">
          <img
            src="/logo.png"
            alt="Cortoba Supplies"
            className="h-20 w-20 object-contain mx-auto mb-3"
          />
          <h1 className="text-2xl font-bold text-foreground">{t("login.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("login.subtitle")}</p>
          <p className="text-muted-foreground text-xs mt-1">{t("login.address")}</p>
          <p className="text-muted-foreground text-sm mt-3">{t("login.signIn")}</p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">{t("login.email")}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@cortoba-supplies.com"
                required
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">{t("login.password")}</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 px-3 py-2 rounded">
                <AlertCircle size={14} />
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? t("login.signingIn") : t("login.button")}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
