/*
 * Tailwind candidate parity sanity harness.
 *
 * Run:
 *   node --experimental-strip-types tests/tailwindCandidates.sanity.mts
 *
 * Three checks:
 *
 *   1. Completion candidates exactly match Tailwind's own class list
 *      (`getClassList()`), so a Tailwind upgrade cannot silently leave the
 *      IDE offering stale/missing classes.
 *   2. Variants and hovers are accepted by the real design system.
 *   3. The workspace scanner finds every valid class found by Tailwind's
 *      own scanner (`@tailwindcss/oxide`) for a fixture corpus. The scanner
 *      is allowed to return extra tokens; Tailwind discards invalid ones.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Scanner } from "@tailwindcss/oxide";
import { __unstable__loadDesignSystem } from "tailwindcss";

import { extractCandidates } from "../src/extensions/tailwind/scan.ts";
import { loadTailwindClassIndex } from "../src/extensions/tailwind/theme.ts";

const TAILWIND_PACKAGE = new URL("../node_modules/tailwindcss/", import.meta.url);

function readTailwindFile(path: string): string {
  return readFileSync(new URL(path, TAILWIND_PACKAGE), "utf8");
}

const loadStylesheet = async (id: string) => {
  if (id === "tailwindcss") {
    return {
      path: "tailwindcss/index.css",
      base: "/",
      content: readTailwindFile("index.css"),
    };
  }

  if (id === "tailwindcss/theme.css" || id === "tailwindcss/theme") {
    return { path: id, base: "/", content: readTailwindFile("theme.css") };
  }

  if (id === "tailwindcss/preflight.css" || id === "tailwindcss/preflight") {
    return { path: id, base: "/", content: readTailwindFile("preflight.css") };
  }

  if (id === "tailwindcss/utilities.css" || id === "tailwindcss/utilities") {
    return { path: id, base: "/", content: "@tailwind utilities;" };
  }

  throw new Error(`Unexpected stylesheet import: ${id}`);
};

/*
 * 1. Completion parity
 */

const designSystem = await __unstable__loadDesignSystem('@import "tailwindcss";', {
  loadStylesheet,
});

const classIndex = await loadTailwindClassIndex({ loadStylesheet });

const actualClasses = designSystem.getClassList().map(([name]) => name);
const actualSet = new Set(actualClasses);

const generatedClasses = classIndex.candidates.map((candidate) => candidate.className);
const generatedSet = new Set(generatedClasses);

assert.ok(
  actualClasses.length > 20_000,
  `expected a full Tailwind class list, got ${actualClasses.length}`,
);

assert.equal(
  generatedSet.size,
  generatedClasses.length,
  "completion candidates contain duplicates",
);

const missing = actualClasses.filter((name) => !generatedSet.has(name));
assert.deepEqual(
  missing,
  [],
  `missing ${missing.length} Tailwind classes, e.g. ${missing.slice(0, 20).join(", ")}`,
);

const extra = generatedClasses.filter((name) => !actualSet.has(name));
assert.deepEqual(
  extra,
  [],
  `generated ${extra.length} classes Tailwind does not know, e.g. ${extra.slice(0, 20).join(", ")}`,
);

for (const className of [
  "bg-slate-500",
  "text-red-500",
  "border-2",
  "font-bold",
  "p-4",
  "-mt-4",
  "w-1/2",
  "rounded-lg",
  "max-w-prose",
  "text-2xl",
  "grid-cols-3",
]) {
  assert.ok(generatedSet.has(className), `missing known class ${className}`);
}

/*
 * Regressions from the old theme-table generator: these were offered even
 * though Tailwind rejects them.
 */
for (const className of ["bg-slate", "text-blue", "border-DEFAULT", "font-700"]) {
  assert.ok(!generatedSet.has(className), `offered invalid class ${className}`);
}

/*
 * 2. Variants + hover
 */

const variantNames = new Set(
  classIndex.variants.map((variant) => variant.prefix.replace(/:$/, "")),
);

for (const name of [
  "hover",
  "focus-visible",
  "sm",
  "@sm",
  "max-md",
  "group-hover",
  "peer-focus",
  "aria-busy",
  "motion-safe",
  "dark",
  "print",
]) {
  assert.ok(variantNames.has(name), `missing variant ${name}:`);
}

for (const name of ["data", "nth", "supports"]) {
  assert.ok(!variantNames.has(name), `suggested ${name} even though it needs an arbitrary value`);
}

for (const variant of classIndex.variants) {
  const [css] = designSystem.candidatesToCss([`${variant.prefix}flex`]);

  assert.notEqual(css, null, `variant ${variant.prefix} is not accepted by Tailwind`);
}

const expectedVariants = new Set<string>();

for (const entry of designSystem.getVariants()) {
  const values: (string | null)[] = entry.values.length === 0 ? [null] : entry.values;

  for (const value of values) {
    const name =
      value == null ? entry.name : entry.name === "@" ? `@${value}` : `${entry.name}-${value}`;

    if (designSystem.candidatesToCss([`${name}:flex`])[0] != null) {
      expectedVariants.add(name);
    }
  }
}

const missingVariants = [...expectedVariants].filter((name) => !variantNames.has(name));

assert.deepEqual(
  missingVariants,
  [],
  `missing ${missingVariants.length} Tailwind variants, e.g. ${missingVariants
    .slice(0, 20)
    .join(", ")}`,
);

assert.ok(
  classIndex.variants.length > 50,
  `expected a broad variant list, got ${classIndex.variants.length}`,
);

assert.match(classIndex.hoverInfo("bg-red-500") ?? "", /background-color/);

assert.match(classIndex.hoverInfo("hover:bg-red-500") ?? "", /hover/);

assert.match(classIndex.hoverInfo("w-[13px]") ?? "", /13px/);

assert.match(classIndex.hoverInfo("content-['hello']") ?? "", /hello/);

assert.equal(classIndex.hoverInfo("bg-slate"), undefined, "hover accepted an invalid class");

/*
 * 3. Workspace scanner parity
 */

const scannerFixtures: Array<{
  name: string;
  extension: string;
  content: string;
}> = [
  {
    name: "html class attribute",
    extension: "html",
    content:
      '<div class="flex items-center bg-slate-500 hover:bg-red-500 p-4 sm:p-6 text-[13px]"></div>',
  },
  {
    name: "single-quoted attribute",
    extension: "html",
    content: "<div class='flex bg-blue-500'></div>",
  },
  {
    name: "jsx className",
    extension: "tsx",
    content:
      'const App = () => <div className="flex bg-red-500">{items.map((item) => <span className="text-sm">{item}</span>)}</div>;',
  },
  {
    name: "template literal",
    extension: "tsx",
    content: 'const classes = `flex ${active ? "bg-green-500" : "bg-red-500"} p-4`;',
  },
  {
    name: "conditional expression",
    extension: "tsx",
    content: '<div className={active ? "bg-red-500" : "bg-blue-500"}></div>',
  },
  {
    name: "unquoted attribute",
    extension: "html",
    content: "<div class=flex></div>",
  },
  {
    name: "arbitrary values",
    extension: "html",
    content:
      '<div class="w-[calc(100%-2rem)] bg-[#123456] grid-cols-[1fr_2fr] bg-(--my-color)"></div>',
  },
  {
    name: "quoted arbitrary values",
    extension: "html",
    content: `<div class="content-['hello'] bg-[url('x.png')]"></div>`,
  },
  {
    name: "variants and modifiers",
    extension: "html",
    content:
      '<div class="bg-red-500/50 border-2 rounded-lg !flex -mt-4 w-1/2 group-hover:underline"></div>',
  },
  {
    name: "markdown prose",
    extension: "md",
    content: "Use `bg-red-500` for red backgrounds, or bg-blue-500 without code fences.",
  },
  {
    name: "css apply list",
    extension: "css",
    content: ".button { @apply flex items-center bg-red-500 px-4; }",
  },
  {
    name: "svelte class shorthand",
    extension: "svelte",
    content: "<div class:flex='condition' class:px-4={condition}></div>",
  },
  {
    name: "angular class binding",
    extension: "html",
    content:
      '<div [class.underline]="bool" [class.px-2.5]="bool" [class.bg-[#0088cc]]="bool"></div>',
  },
  {
    name: "arbitrary variants",
    extension: "html",
    content: '<div class="[&>[data-slot=icon]:last-child]:right-2.5 @-[36rem]:flex"></div>',
  },
  {
    name: "pug class literals",
    extension: "pug",
    content: `<div class="x">\n.bg-green-300.2xl:bg-red-500\ninput(type="checkbox" class="px-2.5")`,
  },
  {
    name: "slim class literals",
    extension: "slim",
    content: `.bg-blue-100.2xl:bg-red-100\ndiv class="px-2.5"`,
  },
  {
    name: "haml class literals",
    extension: "haml",
    content: "%body.flex.flex-col.items-center.justify-center",
  },
  {
    name: "ruby word array",
    extension: "rb",
    content: "%w[flex items-center] %w[[color:red]]",
  },
  {
    name: "clojure wrapped classes",
    extension: "cljs",
    content: '[:div {:class ["p-2" "text-green"]}] [:div.p-2]',
  },
  {
    name: "csharp wrapped classes",
    extension: "cshtml",
    content: '[CssClass("gap-y-4")] [CssClass("hover:gap-y-4")]',
  },
  {
    name: "markdown inline directives",
    extension: "md",
    content: ":span[Some Text]{.text-gray-500.bg-red-500}",
  },
  {
    name: "twig conditions",
    extension: "twig",
    content: '<div class="{% if true %}flex{% else %}block{% endif %}"></div>',
  },
  {
    name: "template toolkit conditions",
    extension: "tt",
    content: '<div class="[% IF $is_open %]bg-white/40[% ELSE %]bg-white/10[% END %]"></div>',
  },
  {
    name: "php escaped quotes",
    extension: "php",
    content: String.raw`$attributes->merge(['x-init' => '$el.classList.add(\'-translate-x-full\'); $el.classList.add(\'transition-transform\')']);`,
  },
  {
    name: "nested arrays and overlaps",
    extension: "ts",
    content: '["flex",["italic",["underline"]]]',
  },
  {
    name: "arbitrary variant overlap",
    extension: "ts",
    content: "[:is(italic):is(underline)]:flex",
  },
];

for (const fixture of scannerFixtures) {
  const scanner = new Scanner({ sources: [] });

  const expected = scanner
    .scanFiles([
      {
        content: fixture.content,
        extension: fixture.extension,
      },
    ])
    .filter((candidate) => designSystem.candidatesToCss([candidate])[0] != null);

  const ours = new Set(extractCandidates(fixture.content, undefined, fixture.extension));

  const notFound = expected.filter((candidate) => !ours.has(candidate));

  assert.deepEqual(notFound, [], `${fixture.name}: scanner missed ${notFound.join(", ")}`);
}

/*
 * The scanner should also be a superset of Tailwind's in places where
 * Tailwind's own extractor ignores unquoted class values / prose.
 */
for (const content of ["<div class=flex></div>", "Background is bg-red-500 in prose."]) {
  const ours = new Set(extractCandidates(content));

  for (const className of content.match(/\b(?:flex|bg-red-500)\b/g) ?? []) {
    assert.ok(ours.has(className), `broad scan missed ${className}`);
  }
}

console.log(
  `OK - ${generatedClasses.length} completion candidates, ` +
    `${classIndex.variants.length} variants, ` +
    `${scannerFixtures.length} scanner fixtures`,
);
