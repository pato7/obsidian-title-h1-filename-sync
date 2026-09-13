# AGENTS.md — Obsidian Title H1 Filename Sync

Tento súbor slúži ako centrálny zdroj inštrukcií a pravidiel pre všetkých AI agentov pracujúcich na tomto plugine na ľubovoľnom počítači.

---

## 1. Účel a zodpovednosť (Scope)

Plugin pre Obsidian: **Title H1 Filename Sync** (`title-h1-filename-sync`).
Jeho úlohou je obojsmerná synchronizácia medzi:
1. YAML frontmatter hodnotou `title` v Markdown poznámke,
2. Prvým H1 nadpisom (`# Nadpis`) v tele poznámky,
3. Názvom samotného súboru (`<nazov>.md`).

### Súbory a architektúra
- **Zdrojový kód (Source of Truth):** `src/main.ts` (TypeScript).
- **Build systém:** Bundlované cez esbuild (`esbuild.config.mjs`, `tsconfig.json`) do výsledného `main.js`.
- **Manifest:** `manifest.json` (ID, verzia, minimálna verzia Obsidianu, autor).
- **Nastavenia:** `data.json` a predvolené hodnoty v kóde.
- **Konvencie:** Používať výhradne Obsidian API (`obsidian`). Žiadne runtime závislosti tretieho rádu.

---

## 2. Pravidlá pre Git a Workflow (Kľúčové pravidlá pre agenta)

1. **Zákaz priameho commitu do `main`:**
   - Nikdy necommituj a nepushuj zmeny priamo do vetvy `main`.
2. **Kontrola otvorených Pull Requestov pred vytvorením vetvy:**
   - Vždy predtým, než vytvoríš novú branch, spusti `gh pr list --state open` a over, či v repozitári neexistuje nejaký ne-approved / otvorený Pull Request.
   - **Ak otvorený PR existuje:** Okamžite zastav prácu, informuj používateľa a počkaj na jeho schválenie alebo inštrukcie.
   - **Ak otvorený PR neexistuje:** Informuj používateľa, že žiadny otvorený PR neexistuje, a pokračuj.
3. **Vždy začínať z čerstvého `main`:**
   - Pred začatím novej práce prepni na `main` a aktualizuj ho:
     ```bash
     git checkout main
     git pull origin main
     ```
4. **Vytvorenie dedikovanej vetvy:**
   - Každá zmena/funkcia/oprava začína novou branch z aktuálneho `main`:
     ```bash
     git checkout -b feat/<nazov-zmeny>   # alebo fix/<nazov-opravy>
     ```
5. **Postupný update a commitovanie:**
   - Počas vývoja commituj zmeny do tejto aktívnej vetvy a pushuj ich na GitHub:
     ```bash
     git push -u origin <nazov-vetvy>
     ```
6. **Vytvorenie Pull Requestu IBA na pokyn:**
   - **NIKDY nevytváraj Pull Request automaticky.**
   - Pull Request do vetvy `main` vytvoríš **VÝHRADNE VTEDY**, keď používateľ povie, že ideme na produkciu (napr. *"ideme na produkciu"*, *"vytvor PR"*, *"sprav pull request"*).
   - Následne používateľ Pull Request sám skontroluje a schváli.
7. **Pravidlo navýšenia verzie (Version Bump):**
   - Pri **každej** úprave alebo zmene kódu/pluginu sa **musí zvýšiť verzia** v `manifest.json` aj v `package.json` (napr. `1.4.1` -> `1.4.2`).
8. **Synchronizácia s lokálnym vaultom Obsidianu:**
   - Po zostavení (`npm run build`) skopíruj aktuálny `main.js` a `manifest.json` do priečinka nainštalovaného pluginu v lokálnom vaulte Obsidianu:
     `c:\Users\pato\My Drive\Obsidian\.obsidian\plugins\title-h1-filename-sync\`

---

## 3. Technické a funkčné pravidlá pluginu

### Nové a nepomenované súbory (`Untitled`)
- Nové poznámky vytvorené Obsidianom majú predvolený názov `Untitled` (alebo `Untitled 1`, `Bez názvu` atď.).
- Akonáhle používateľ do takejto poznámky napíše H1 nadpis alebo `title`, **súbor sa musí okamžite premenovať** podľa tohto nadpisu.
- Pomocná funkcia `isUntitled(basename)` rozoznáva tieto dočasné názvy.

### Ochrana používateľom manuálne premenovaných súborov
- Ak súbor už má vlastný názov (nie je `Untitled`) a používateľ upravuje iba telo textu (pričom H1 ani `title` sa nezmenili), plugin **nesmie** prepísať názov súboru späť na H1, pokiaľ používateľ výslovne nestlačí `Ctrl+S` (`Cmd+S`) alebo nespustí synchronizačný príkaz.

### Asynchrónny zápis a zámok súborov (Google Drive / Windows)
- Pri úprave frontmatteru (`processFrontMatter`) a následnom premenovaní súboru (`renameFile`) môže dôjsť k zablokovaniu súboru systémom Windows alebo Google Drive sync klientom (`EBUSY`).
- `syncFilename` musí vždy načítať čerstvú inštanciu `TFile` z vaultu a v prípade chyby počkať 200 ms a premenovanie zopakovať.

### Notifikácie (Toast Notice)
- Vizuálne toast notifikácie (`new Notice(...)`) sa zobrazujú **výhradne pri manuálnom uložení cez `Ctrl+S` / `Cmd+S`** alebo pri manuálnom príkaze z palety.
- Počas bežného písania v editore prebieha synchronizácia na pozadí ticho (bez vyskakovacích okien).
- Všetky správy a texty musia byť v **angličtine** (pre potreby publikácie v Obsidian Community Plugins).

---

## 4. Postup validácie (Validation Method)

1. Po úprave kódu v `src/main.ts` otestuj typy a zostav build:
   ```bash
   npm run build
   ```
2. Skontroluj, či `main.js` neobsahuje syntaktické chyby.
3. Over, či sa verzia v `manifest.json` a `package.json` zhoduje a bola navýšená.
4. Skopíruj výstup do lokálneho trezoru Obsidianu.
