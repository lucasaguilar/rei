---
name: reconcile-finances
description: Faithfully reconcile & categorize a financial document (bank/credit-card statement, expenses CSV) — extract transactions, verify the sum against the printed total with a script, then report by category
modes: agent
---

# Skill: Reconcile & categorize a financial document

Use when asked to add up, reconcile, or categorize expenses/income from a bank statement,
credit-card summary, or an expenses CSV (from a PDF, image, or `.csv`).

**Golden rule: NEVER add up amounts in your head or "in reasoning".** Local models (and you)
miscount long lists. The arithmetic is ALWAYS done by a script you write and RUN with `run_command`.
Your job is to extract faithfully and classify; the *code* is the oracle for the numbers.

## Path discipline (READ THIS — it's where this task usually breaks)

You are already running INSIDE the workspace root. Use ONE script at the **exact fixed path
`.rei/tmp/reconcile.py`** everywhere — this keeps the repo clean and the script auditable:

- Create it with `create_file` at exactly `.rei/tmp/reconcile.py`.
- Run it with the SAME path: `python3 .rei/tmp/reconcile.py` (or `.rei/tmp/reconcile.mjs` + `node`).
- NEVER prefix the workspace folder name: if the workspace is `rei-ocr`, do NOT write
  `rei-ocr/.rei/tmp/reconcile.py` — that creates `rei-ocr/rei-ocr/...` and every run then fails.
- If a run fails, do NOT re-issue the identical command (it gets blocked) and do NOT hunt for the
  file across other paths — the path is `.rei/tmp/reconcile.py`, period; fix the SCRIPT, not the path.

Prefer **one self-contained script** with the transactions embedded as a list — that avoids juggling
a second CSV file. python3 or node, your choice; be consistent.

## Steps

1. **Read the source.** For a `.csv`, read it with `read_files`. For a PDF/image, the OCR/text is in
   the active document `ocr/<name>.ocr.md` — read that. Keep it; you verify every number against it.

2. **Find the PRINTED TOTAL** — "total del período", "saldo", "total a pagar". This is ground truth.
   If the doc truly has none, say so and reconcile against nothing (report the computed total only).

3. **Write ONE script** at `.rei/tmp/reconcile.py` (`create_file`) that contains, inline:
   - the list of transactions you extracted VERBATIM from the source: `(fecha, descripcion, monto)`,
     each amount copied exactly as printed; skip TOTAL/SALDO rows (they double-count),
   - amount parsing (see below), summing in integer cents (`round(x*100)`) to avoid float drift,
   - the printed total as a constant to reconcile against,
   - and it must **print** a finished markdown report to stdout (table + totals + verdict).

4. **Run it once** with `run_command`: `python3 .rei/tmp/reconcile.py`.

5. **RECONCILE.** If the script's total ≠ the printed total, you missed or misread rows. Edit the
   transaction list in the script (`edit_file`), re-run, and repeat until it matches — or, if you
   cannot, report the exact discrepancy and which rows are uncertain. Do NOT proceed on unreconciled
   numbers, and do NOT sum anything yourself.

6. **Grounding.** Every amount in the script must appear verbatim in the source. Invented number →
   remove it.

7. **Classify + subtotal.** Assign each `descripcion` a category (judgment: "Cafe Martinez"→
   Gastronomía, "YPF"→Transporte, "Transferencia recibida"→Ingresos…). Have the SAME script group by
   category, print `Categoría | Mov. | Subtotal`, and assert the subtotals add back to the total.

8. **Present the script's printed report as your answer** — the markdown table + a verdict line:
   - `✅ Reconciliado: coincide con el total impreso del resumen ($X).`
   - or `⚠️ NO reconcilia: el resumen dice $X, las filas suman $Y (diferencia $Z).`
   Do not narrate the file edits; the report IS the answer. Only then, if asked, advise — strictly
   from these verified numbers.

## Amount parsing (get this right — the reconciliation depends on it)

- Parentheses `(1.234,56)` or a minus sign ⇒ **negative**.
- Strip currency/letters/spaces (`$`, `ARS`, `USD`).
- If the value has BOTH `.` and `,`: the LAST one is the decimal separator, the other is the
  thousands grouping. `1.234,56` → 1234.56 (es); `1,234.56` → 1234.56 (en).
- If it has only ONE separator: `sep + exactly 1–2 trailing digits` = decimal (`12,50`→12.5,
  `47500.00`→47500); otherwise it's a thousands grouping (`1.234`→1234, `1,000`→1000).

## Multi-source

If the user adds more sources (another card, a bank export), extract each into its own CSV, reconcile
EACH against its own printed total first, then concatenate the reconciled rows and report the combined
totals by category. Never mix un-reconciled sources.
