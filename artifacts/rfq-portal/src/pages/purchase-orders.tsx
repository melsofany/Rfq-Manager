import { Layout } from "@/components/Layout";
import { ShoppingCart } from "lucide-react";

export default function PurchaseOrdersPage() {
  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold text-foreground">Purchase Orders</h1>
          <p className="text-muted-foreground text-sm">Manage purchase orders (PO)</p>
        </div>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="p-12 text-center">
            <ShoppingCart size={40} className="mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground text-sm">No purchase orders yet</p>
          </div>
        </div>
      </div>
    </Layout>
  );
}
