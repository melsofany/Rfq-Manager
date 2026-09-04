import { Layout } from "@/components/Layout";
import { Calculator } from "lucide-react";

export default function AccountsPage() {
  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Calculator size={20} className="text-primary" />
            الحسابات
          </h1>
          <p className="text-muted-foreground text-sm">
            صفحه الحسابات فارغه حاليا
          </p>
        </div>
      </div>
    </Layout>
  );
}
