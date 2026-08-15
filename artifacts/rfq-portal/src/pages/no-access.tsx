import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldAlert, LogOut } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Shown when an employee has been granted no pages at all (every permission
 * revoked). They are logged in but there is nothing they can open — instead of
 * a blank/redirect-loop, show a clear message + a sign-out button.
 */
export default function NoAccess() {
  const { t } = useLanguage();
  const { employee, logout } = useAuth();

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2 items-center">
            <ShieldAlert className="h-8 w-8 text-amber-500 flex-shrink-0" />
            <h1 className="text-xl font-bold text-gray-900">{t("noAccess.title")}</h1>
          </div>

          <p className="mt-2 text-sm text-gray-600">{t("noAccess.message")}</p>
          {employee && (
            <p className="mt-2 text-xs text-gray-500">
              {employee.name} · {employee.email}
            </p>
          )}
          <p className="mt-3 text-sm text-gray-600">{t("noAccess.contactAdmin")}</p>

          <div className="mt-6">
            <Button onClick={logout} variant="outline" className="w-full gap-2">
              <LogOut size={16} />
              {t("noAccess.signOut")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
