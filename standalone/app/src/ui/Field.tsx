/** 表单一行：左标签、右输入框。密钥一律掩码，不回显已存的值。 */
import type { InputHTMLAttributes } from "react";

import s from "./Field.module.css";

export function Field({ label, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={s.field}>
      <span className={s.label}>{label}</span>
      <input className={s.input} {...input} />
    </label>
  );
}
