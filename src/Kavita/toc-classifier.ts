import type { NovelTocRole } from "./models.js";

const STRUCTURAL_PATTERNS = [
  /^navigation$/iu,
  /^cover$/iu,
  /^contents$/iu,
  /^table\s+of\s+contents$/iu,
  /^title\s+page$/iu,
  /^copyright$/iu,
  /^colophon$/iu,
  /^imprint$/iu,
  /^dedication$/iu,
];

const PUBLISHER_PATTERNS = [
  /\bnewsletter\b/iu,
  /^about\s+(?:j[-\s]?novel\s+club|yen\s+press|seven\s+seas|the\s+publisher|publisher)/iu,
  /^publisher\s+information$/iu,
  /^also\s+available\b/iu,
  /^more\s+from\s+(?:this\s+)?publisher\b/iu,
  /^catalog(?:ue)?$/iu,
  /^advertisements?$/iu,
  /^preview$/iu,
  /^sneak\s+peek$/iu,
  /^credits$/iu,
  /\bwebsite\b/iu,
  /\bsocial[-\s]?media\b/iu,
];

const FRONTMATTER_PATTERNS = [
  /^inserts?$/iu,
  /^(?:color\s+)?illustrations?$/iu,
  /^frontispiece$/iu,
  /^character\s+(?:page|profiles?)$/iu,
  /^gallery$/iu,
  /^dramatis\s+personae$/iu,
  /^map$/iu,
];

const READABLE_SPECIAL_PATTERNS = [
  /^prologue\b/iu,
  /^epilogue\b/iu,
  /^afterword\b/iu,
  /^interlude\b/iu,
  /^side\s+story\b/iu,
  /^bonus\b/iu,
  /^extra\b/iu,
];

export function classifyNovelTocTitle(title: string | undefined): NovelTocRole {
  const text = title?.trim() ?? "";
  if (!text) return "narrative";
  if (STRUCTURAL_PATTERNS.some((pattern) => pattern.test(text))) return "structural";
  if (PUBLISHER_PATTERNS.some((pattern) => pattern.test(text))) return "publisher-backmatter";
  if (FRONTMATTER_PATTERNS.some((pattern) => pattern.test(text))) return "frontmatter";
  if (READABLE_SPECIAL_PATTERNS.some((pattern) => pattern.test(text))) return "readable-special";
  return "narrative";
}

export function isNovelTocRoleSpecial(role: NovelTocRole): boolean {
  return role === "frontmatter" || role === "readable-special" || role === "publisher-backmatter";
}

export function novelTocRolePriority(role: NovelTocRole): number {
  if (role === "narrative") return 5;
  if (role === "readable-special") return 4;
  if (role === "frontmatter") return 3;
  if (role === "publisher-backmatter") return 2;
  return 1;
}
