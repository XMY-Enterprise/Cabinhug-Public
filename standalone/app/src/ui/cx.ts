/** 拼 className：假值跳过。CSS Module 的类名是哈希，条件类只能这样拼。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
