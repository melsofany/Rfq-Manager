import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListEmployees,
  useCreateEmployee,
  getListEmployeesQueryKey,
} from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { Plus, X, UserCog } from "lucide-react";

const ROLES = ["admin", "manager", "purchasing"];

export default function EmployeesPage() {
  const { employee: me } = useAuth();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "purchasing", phone: "" });
  const [formError, setFormError] = useState<string | null>(null);

  const { data: employees, isLoading } = useListEmployees({
    query: { queryKey: getListEmployeesQueryKey() },
  });

  const createMutation = useCreateEmployee({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() });
        setShowForm(false);
        setForm({ name: "", email: "", password: "", role: "purchasing", phone: "" });
        setFormError(null);
      },
      onError: (err: unknown) => {
        const detail = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setFormError(detail ?? "فشل في إضافة الموظف، يرجى المحاولة مرة أخرى");
      },
    },
  });

  if (me?.role !== "admin") {
    return (
      <Layout>
        <div className="p-6 text-muted-foreground text-sm">Access denied. Admin only.</div>
      </Layout>
    );
  }

  const update = (field: string, value: string) => setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({ data: form as Parameters<typeof createMutation.mutate>[0]["data"] });
  };

  return (
    <Layout>
      <div className="p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-foreground">Employees</h1>
            <p className="text-muted-foreground text-sm">Manage system access and roles</p>
          </div>
          <Button onClick={() => setShowForm(true)} size="sm" className="gap-1.5">
            <Plus size={15} /> Add Employee
          </Button>
        </div>

        {/* Add Employee Form */}
        {showForm && (
          <div className="bg-card border border-border rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-foreground">New Employee</h2>
              <button onClick={() => { setShowForm(false); setFormError(null); }} className="text-muted-foreground hover:text-foreground">
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Full Name *</Label>
                <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Ahmed Al-Rashidi" required />
              </div>
              <div className="space-y-1.5">
                <Label>Email *</Label>
                <Input value={form.email} onChange={(e) => update("email", e.target.value)} type="email" placeholder="ahmed@cortoba-supplies.com" required />
              </div>
              <div className="space-y-1.5">
                <Label>Password *</Label>
                <Input value={form.password} onChange={(e) => update("password", e.target.value)} type="password" placeholder="••••••••" required minLength={6} />
              </div>
              <div className="space-y-1.5">
                <Label>Role *</Label>
                <select
                  value={form.role}
                  onChange={(e) => update("role", e.target.value)}
                  className="w-full h-9 px-3 rounded border border-input bg-background text-sm text-foreground"
                  required
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r} className="capitalize">{r}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input value={form.phone} onChange={(e) => update("phone", e.target.value)} placeholder="+966-50-000-0000" />
              </div>
              <div className="col-span-2 flex gap-3 justify-end pt-1">
                <Button type="button" variant="ghost" onClick={() => setShowForm(false)} size="sm">Cancel</Button>
                {formError && (
                  <div className="col-span-2 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 text-right">
                    ⚠ {formError}
                  </div>
                )}
              <Button type="submit" size="sm" disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Saving..." : "Create Employee"}
                </Button>
              </div>
            </form>
          </div>
        )}

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
          ) : !employees?.length ? (
            <div className="p-12 text-center">
              <UserCog size={40} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">No employees found</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/30 border-b border-border text-left">
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Name</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Email</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Phone</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Role</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">Status</th>
                  <th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">Joined</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((emp) => (
                  <tr key={emp.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold">
                          {emp.name[0]?.toUpperCase()}
                        </div>
                        <span className="font-medium text-foreground">{emp.name}</span>
                        {emp.id === me?.id && <span className="text-xs text-muted-foreground">(you)</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{emp.email}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{emp.phone ?? "-"}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${
                        emp.role === "admin" ? "bg-purple-50 text-purple-700"
                        : emp.role === "manager" ? "bg-blue-50 text-blue-700"
                        : "bg-muted text-muted-foreground"
                      }`}>
                        {emp.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        emp.isActive ? "bg-green-50 text-green-700" : "bg-muted text-muted-foreground"
                      }`}>
                        {emp.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {new Date(emp.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  );
}
