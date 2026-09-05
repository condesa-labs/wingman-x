import { describe, expect, it } from "vitest";
import { buildKBIndex, buildKBIndexFromDocs, chunkMarkdown, renderExcerpts, tokenize } from "../src/kb/kb-index.js";

const docs = [
  {
    id: "private-credit",
    title: "Private credit",
    markdown: [
      "# Private credit",
      "",
      "<!-- seed -->",
      "",
      "## What I know",
      "- Borrowing bases, advance rates, eligibility criteria, servicer roles.",
      "",
      "## Why financing utility matters",
      "For tokenized private credit, secondary liquidity is not the first bottleneck. The first bottleneck is whether a lender will finance the tokenized position.",
      "",
      "## Empty section",
      "",
    ].join("\n"),
  },
  {
    id: "custody",
    title: "Custody",
    markdown: "# Custody\n\nInstitutional custody changes collateral design. Control agreements decide what a lender can enforce.\n",
  },
];

describe("chunkMarkdown", () => {
  it("splits on headings, skips empty sections, and produces stable refs", () => {
    const chunks = chunkMarkdown(docs[0]!);
    expect(chunks.map((c) => c.ref)).toEqual([
      "library/private-credit.md#what-i-know",
      "library/private-credit.md#why-financing-utility-matters",
    ]);
    expect(chunks[0]?.file).toBe("library/private-credit.md");
    expect(chunks[1]?.text).toContain("first bottleneck");
  });

  it("uses the title for a heading-less body and splits overlong sections", () => {
    const long = { id: "x", title: "X", markdown: `# X\n\n${"A sentence about settlement. ".repeat(120)}` };
    const chunks = chunkMarkdown(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.ref).toBe("library/x.md#x-p1");
    expect(chunkMarkdown({ id: "y", title: "Y", markdown: "plain body without heading" })[0]?.heading).toBe("Y");
  });
});

describe("buildKBIndexFromDocs.search", () => {
  const index = buildKBIndexFromDocs("tone text", docs);

  it("ranks the semantically closest chunk first and respects k", () => {
    const hits = index.search("tokenized private credit needs secondary liquidity before anything else", 2);
    expect(hits[0]?.ref).toBe("library/private-credit.md#why-financing-utility-matters");
    expect(hits).toHaveLength(2);
  });

  it("finds custody content from collateral vocabulary via stemming", () => {
    const hits = index.search("custodians and collateralized lending", 3);
    expect(hits.some((h) => h.file === "library/custody.md")).toBe(true);
  });

  it("returns nothing for empty or stopword-only queries", () => {
    expect(index.search("the and of", 3)).toEqual([]);
    expect(index.search("", 3)).toEqual([]);
  });

  it("exposes a per-file summary, tone, files, and lookup helpers", () => {
    expect(index.tone).toBe("tone text");
    expect(index.files).toEqual(["library/private-credit.md", "library/custody.md"]);
    expect(index.summary).toContain("Private credit (library/private-credit.md)");
    expect(index.summary).toContain("Custody (library/custody.md): Institutional custody changes");
    expect(index.chunksByRef(["library/custody.md#custody"]).map((c) => c.file)).toEqual(["library/custody.md"]);
    expect(index.chunksForFiles(["library/private-credit.md"], 1)).toHaveLength(1);
  });

  it("renderExcerpts labels excerpts and handles the empty case", () => {
    expect(renderExcerpts([])).toMatch(/no knowledge base excerpts/);
    const text = renderExcerpts(index.search("borrowing base", 1));
    expect(text).toMatch(/^\[K1\] library\/private-credit\.md#/);
  });

  it("tokenize drops stopwords, short tokens and urls, and stems", () => {
    expect(tokenize("The tokenization of https://x.com/a assets is tokenized")).toEqual(["token", "asset", "token"]);
  });
});

describe("constraint files", () => {
  it("pulls library/boundaries.md out of retrieval and exposes it as constraints", () => {
    const index = buildKBIndexFromDocs("t", [
      ...docs,
      { id: "boundaries", title: "Boundaries", markdown: "# Boundaries\n\n<!-- note -->\n- NAV Lend: no specifics.\n" },
    ]);
    expect(index.constraints).toBe("# Boundaries\n\n\n- NAV Lend: no specifics.");
    expect(index.files).not.toContain("library/boundaries.md");
    expect(index.search("NAV Lend specifics", 5).map((c) => c.file)).not.toContain("library/boundaries.md");
    expect(buildKBIndexFromDocs("t", docs).constraints).toBe("");
  });
});

describe("buildKBIndex (loader adapter)", () => {
  it("reads tone + library entries through the Wingman loader interface", async () => {
    const index = await buildKBIndex({
      getTone: async () => ({ markdown: "voice" }),
      listLibrary: async () => [{ id: "custody", title: "Custody" }],
      getLibraryEntry: async () => ({ markdown: docs[1]!.markdown }),
    });
    expect(index.tone).toBe("voice");
    expect(index.chunks).toHaveLength(1);
  });
});
