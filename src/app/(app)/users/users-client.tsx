"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, ShieldCheck, UserCog } from "lucide-react";
import { api, errorMessage, patchJson, postJson } from "@/lib/client/api";
import { ROLE_LABELS } from "@/lib/constants";
import { Alert, Badge, Button, Field, Modal } from "@/components/ui";

type Member = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  role: string;
  joinedAt: string;
  permissions: string[];
};

type AuditLog = {
  id: string;
  action: string;
  entityType: string;
  createdAt: string;
  userName: string | null;
};

type Payload = {
  members: Member[];
  matrix: Record<string, { label: string; permissions: string[] }>;
  audit: AuditLog[];
  availablePermissions: Array<{ key: string; labelAr: string; groupAr: string }>;
};

const ROLES = ["owner", "accountant", "cashier", "inventory_manager", "viewer"] as const;

export function UsersClient() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "cashier" });
  const [passwordFor, setPasswordFor] = useState<Member | null>(null);
  const [permissionFor, setPermissionFor] = useState<Member | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<Payload>("/api/users"));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/users", form);
      setOpen(false);
      setForm({ name: "", email: "", password: "", role: "cashier" });
      setMessage("تمت إضافة المستخدم");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function changeRole(member: Member, role: string) {
    setError(null);
    try {
      await patchJson(`/api/users/${member.id}`, { role });
      setMessage("تم تحديث الصلاحية");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function resetPassword(event: React.FormEvent) {
    event.preventDefault();
    if (!passwordFor) return;
    setSaving(true);
    setError(null);
    try {
      await patchJson(`/api/users/${passwordFor.id}`, { password });
      setPasswordFor(null);
      setPassword("");
      setMessage("تم تغيير كلمة المرور");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function savePermissions(event: React.FormEvent) {
    event.preventDefault();
    if (!permissionFor) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/users/${permissionFor.id}/permissions`, { method: "PUT", body: JSON.stringify({ permissions: selectedPermissions }) });
      setPermissionFor(null);
      setMessage("تم تحديث صلاحيات المستخدم");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const matrix = data?.matrix ?? {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">المستخدمون</h1>
          <p className="text-xs text-ink-500">إدارة الحسابات والصلاحيات وسجل النشاط</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> مستخدم جديد
        </Button>
      </div>

      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>الاسم</th>
              <th>البريد</th>
              <th>الدور</th>
              <th>تاريخ الانضمام</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {data?.members.map((member) => (
              <tr key={member.id}>
                <td className="flex items-center gap-2 text-xs font-medium">
                  <UserCog className="h-4 w-4 text-ink-400" /> {member.name}
                </td>
                <td dir="ltr" className="text-xs text-ink-500">{member.email}</td>
                <td>
                  <select
                    className="input h-8 py-0 text-xs"
                    value={member.role}
                    onChange={(e) => changeRole(member, e.target.value)}
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role] ?? role}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="text-[11px] text-ink-400">
                  {new Intl.DateTimeFormat("ar-YE").format(new Date(member.joinedAt))}
                </td>
                <td>
                  <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => { setPermissionFor(member); setSelectedPermissions(member.permissions); }}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-brand-700 hover:bg-brand-50"
                    title="تحديد صلاحيات هذا المستخدم"
                  >
                    <ShieldCheck className="h-3 w-3" /> الصلاحيات
                  </button>
                  <button
                    type="button"
                    onClick={() => setPasswordFor(member)}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-ink-600 hover:bg-ink-100"
                  >
                    <KeyRound className="h-3 w-3" /> كلمة المرور
                  </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
          <h2 className="border-b border-ink-100 px-4 py-3 text-sm font-semibold">مصفوفة الصلاحيات</h2>
          <div className="divide-y divide-ink-100">
            {Object.entries(matrix).map(([role, info]) => (
              <div key={role} className="px-4 py-3">
                <p className="text-xs font-semibold">{info.label}</p>
                <p className="mt-1 text-[11px] leading-5 text-ink-500">
                  {info.permissions.join(" · ")}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-ink-200 bg-white shadow-card">
          <h2 className="border-b border-ink-100 px-4 py-3 text-sm font-semibold">سجل النشاط</h2>
          <div className="max-h-80 divide-y divide-ink-100 overflow-auto">
            {data?.audit.map((log) => (
              <div key={log.id} className="flex items-center justify-between px-4 py-2 text-[11px]">
                <div>
                  <p className="font-medium" dir="ltr">{log.action}</p>
                  <p className="text-ink-400">
                    {log.userName ?? "النظام"} · {log.entityType}
                  </p>
                </div>
                <span className="text-ink-400">
                  {new Intl.DateTimeFormat("ar-YE", { dateStyle: "short", timeStyle: "short" }).format(
                    new Date(log.createdAt),
                  )}
                </span>
              </div>
            ))}
            {!data?.audit.length ? (
              <p className="px-4 py-6 text-center text-xs text-ink-500">لا يوجد نشاط مسجل</p>
            ) : null}
          </div>
        </section>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="مستخدم جديد"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              إلغاء
            </Button>
            <Button form="user-form" type="submit" loading={saving}>
              حفظ
            </Button>
          </>
        }
      >
        <form id="user-form" onSubmit={create} className="space-y-3">
          <Field label="الاسم">
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </Field>
          <Field label="البريد الإلكتروني">
            <input
              className="input"
              type="email"
              dir="ltr"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </Field>
          <Field label="كلمة المرور" hint="8 أحرف على الأقل">
            <input
              className="input"
              type="text"
              dir="ltr"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              minLength={8}
              required
            />
          </Field>
          <Field label="الدور">
            <select
              className="input"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role] ?? role}
                </option>
              ))}
            </select>
          </Field>
        </form>
      </Modal>

      <Modal
        open={Boolean(permissionFor)}
        onClose={() => setPermissionFor(null)}
        title={`صلاحيات ${permissionFor?.name ?? "المستخدم"}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPermissionFor(null)}>إلغاء</Button>
            <Button form="permissions-form" type="submit" loading={saving}>حفظ الصلاحيات</Button>
          </>
        }
      >
        <form id="permissions-form" onSubmit={savePermissions} className="space-y-4">
          <p className="text-xs leading-5 text-ink-500">تظهر هنا الصلاحيات المتاحة في باقة المؤسسة والميزات التي فعّلها مالك المنصة. تحديد الصلاحية يسمح لهذا المستخدم باستخدام القسم والعمليات المرتبطة بها.</p>
          {Object.entries((data?.availablePermissions ?? []).reduce<Record<string, typeof data.availablePermissions>>((groups, permission) => {
            (groups[permission.groupAr] ??= []).push(permission);
            return groups;
          }, {})).map(([group, permissions]) => (
            <section key={group} className="rounded-xl border border-ink-100">
              <h3 className="border-b border-ink-100 px-3 py-2 text-xs font-semibold">{group}</h3>
              <div className="grid gap-1 p-2 sm:grid-cols-2">
                {permissions.map((permission) => (
                  <label key={permission.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-ink-50">
                    <input type="checkbox" checked={selectedPermissions.includes(permission.key)} onChange={(event) => setSelectedPermissions((current) => event.target.checked ? [...current, permission.key] : current.filter((key) => key !== permission.key))} />
                    {permission.labelAr}
                  </label>
                ))}
              </div>
            </section>
          ))}
        </form>
      </Modal>

      <Modal
        open={Boolean(passwordFor)}
        onClose={() => setPasswordFor(null)}
        title={`كلمة مرور ${passwordFor?.name ?? ""}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPasswordFor(null)}>
              إلغاء
            </Button>
            <Button form="password-form" type="submit" loading={saving}>
              تغيير
            </Button>
          </>
        }
      >
        <form id="password-form" onSubmit={resetPassword} className="space-y-3">
          <Field label="كلمة المرور الجديدة">
            <input
              className="input"
              type="text"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
