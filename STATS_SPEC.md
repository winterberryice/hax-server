# 📊 Haxball Stats System - Specyfikacja

## 🎯 Cel projektu
Rozbudować istniejący skrypt Haxball Headless o system statystyk graczy (bramki, asysty, win rate, ranking).

---

## 🔐 Identyfikacja graczy

### player.auth jako klucz
- Unikalny hash per przeglądarka/komputer
- NIE zmienia się nawet gdy gracz zmienia nick
- Używamy jako PRIMARY KEY w bazie danych

### Aktualizacja nicku
- Automatyczny UPDATE nicku gdy gracz wraca z nowym nickiem
- Ostatni użyty nick jest zapisywany w bazie

---

## 📊 Statystyki

### Globalne (all-time) - Tabela `players`
- **goals** - całkowita liczba bramek
- **assists** - całkowita liczba asyst
- **own_goals** - samobóje
- **games** - rozegrane mecze
- **wins** - wygrane mecze
- **losses** - przegrane mecze
- **draws** - remisy
- **clean_sheets** - mecze bez straconych bramek (dla całego zespołu)
- **minutes_played** - łączny czas gry w minutach (tylko podczas aktywnego meczu)
- **current_streak** - aktualna seria wygranych
- **best_streak** - najlepsza seria wygranych
- **last_seen** - timestamp ostatniej aktywności

### Obliczane (nie w bazie):
- **Win Rate** = `(wins + 0.5 * draws) / (wins + losses + draws)` - jak w szachach
- **Goals per game** = `goals / games`

### Statystyki per mecz - Tabela `match_players`
- Bramki w meczu
- Asysty w meczu
- Zespół (Red=1, Blue=2)
- Czas gry w meczu

### Historia meczów - Tabela `matches`
- **Wszystkie mecze** przechowywane w bazie danych
- Wynik (Red vs Blue)
- Strzelcy z każdego zespołu (przez relację `match_players`)
- Timestamp
- Czas trwania
- Lekkie zapytanie: `ORDER BY timestamp DESC LIMIT 1` dla ostatniego meczu

---

## 🎮 Logika gry

### Wykrywanie goli
```javascript
room.onTeamGoal = (team) => {
  // team = 1 (Red) lub 2 (Blue) - który zespół DOSTAŁ punkt
  // Ostatni gracz który dotknął piłkę = strzelec
}
```

### Wykrywanie samobojów
```
Jeśli ostatnie dotknięcie: gracz z Red
A punkt dostaje: Blue (team = 2)
→ SAMOBÓJ gracza Red
```

### Wykrywanie asyst
- Ostatnie dotknięcie **< 3 sekundy** przed golem
- **NIE** dla samego siebie (gracz nie asystuje sobie)
- Logika: track poprzednie dotknięcie z timestampem

### Czas gry
**Opcja A**: Tylko podczas aktywnego meczu
```javascript
onGameStart → start licznika dla wszystkich w zespołach
onGameStop → stop licznika, zapisz minuty
onPlayerJoin/Leave → pause/resume dla gracza
```

### Win/Loss/Draw
- Przypisywane **na podstawie zespołu w którym gracz SKOŃCZYŁ mecz**
- Zmiana zespołu w trakcie: liczy się zespół końcowy
- **Remis**: gdy wynik jest równy (niezależnie czy admin zakończył czy overtime)
- **Mecze zakończone przez admina**: liczyć normalnie po wyniku

```javascript
room.onGameStop = function(byPlayer) {
  // byPlayer = null → naturalny koniec (time/score limit)
  // byPlayer = admin object → admin zakończył ręcznie

  if (redScore > blueScore) {
    // Red wins, Blue losses
  } else if (blueScore > redScore) {
    // Blue wins, Red losses
  } else {
    // Draw dla wszystkich
  }
}
```

### Clean Sheets
- Dla **całego wygrywającego zespołu** bez straconych bramek
- Przykład: Red wygrywa 3-0 → wszyscy z Red dostają +1 clean_sheet
- Przy remisie 0-0: oba zespoły dostają clean sheet

---

## 💬 Komendy w chacie

### `!stats [nick]` lub `!stats` lub `!me`
Wyświetla pełne statystyki gracza (wielolinijkowe):
```
📊 Statystyki: Jan
⚽ Bramki: 25 | Asysty: 15 | Samobóje: 1
🎮 Mecze: 47 (28W-18L-1D) | Win Rate: 60.6%
🏆 Clean Sheets: 12 | Minuty: 235
📈 Streak: 3 (best: 7) | Goals/Match: 0.53
```

- `!stats` (bez argumentu) → moje statystyki
- `!me` → moje statystyki (alias)
- `!stats Jan` → statystyki Jana
- Jeśli gracz nie istnieje: **"❌ Gracz nie znaleziony"**

### `!rank`
Top strzelców, sortowanie po golach (bez minimum meczów):
```
🏆 TOP 10 STRZELCÓW:
1. Jan - 45 goli
2. Anna - 38 goli
3. Piotr - 32 gole
4. Ola - 28 goli
5. Marek - 25 goli
...
```

### `!last`
Wynik ostatniego meczu ze strzelcami:
```
🏁 Ostatni mecz: Red 5 - 3 Blue
⚽ Strzelcy Red: Jan (3), Anna (2)
⚽ Strzelcy Blue: Piotr (2), Ola (1)
```

Edge case - mecz 0-0:
```
🏁 Ostatni mecz: Red 0 - 0 Blue
⚽ Strzelcy Red: Brak
⚽ Strzelcy Blue: Brak
```

---

## 💾 Baza danych SQLite

### System wersjonowania

Baza danych używa **systemu migracji wersjonowanych**:
- Każda zmiana schema to osobna migracja z numerem wersji
- Aktualny numer wersji przechowywany w tabeli `schema_version`
- Przy starcie sprawdzana jest wersja i wykonywane są brakujące migracje
- Proste zmiany: `ALTER TABLE ADD COLUMN`
- Złożone zmiany: CREATE new → INSERT SELECT → DROP old → RENAME

**Obecna wersja: 1** (initial schema)

### Struktura (relacyjna)

#### Tabela: `schema_version`
```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY
);
```

#### Tabela: `players`
```sql
CREATE TABLE players (
  auth TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goals INTEGER DEFAULT 0,
  assists INTEGER DEFAULT 0,
  own_goals INTEGER DEFAULT 0,
  games INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  draws INTEGER DEFAULT 0,
  clean_sheets INTEGER DEFAULT 0,
  minutes_played INTEGER DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### Tabela: `matches`
```sql
CREATE TABLE matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  score_red INTEGER NOT NULL,
  score_blue INTEGER NOT NULL,
  duration INTEGER DEFAULT 0
);
```

#### Tabela: `match_players`
```sql
CREATE TABLE match_players (
  match_id INTEGER,
  player_auth TEXT NOT NULL,
  team INTEGER NOT NULL CHECK (team IN (1, 2)),
  goals INTEGER DEFAULT 0,
  assists INTEGER DEFAULT 0,
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY (player_auth) REFERENCES players(auth)
);
```

### Lokalizacja
- Plik: `/home/user/hax-server/stats.db`
- Dodany do `.gitignore`
- Docker volume dla trwałości

---

## 🔧 Implementacja techniczna

### Zależności
```json
{
  "dependencies": {
    "playwright": "1.48.2",
    "better-sqlite3": "^11.0.0"
  }
}
```

### Architektura
```
server.mjs              - HTTP server (bez zmian)
haxball.mjs             - Headless room setup + minimalna integracja stats
stats/
  ├── database.mjs      - Klasa StatsDatabase (SQLite operations)
  ├── tracker.mjs       - Klasa HaxballStatsTracker (logika stats + integracja)
  └── index.mjs         - Export modułów
stats.db                - SQLite database file
```

### Integracja w `haxball.mjs`
```javascript
await page.evaluate((config) => {
  const room = window.HBInit(config);

  // Expose functions do komunikacji z Node.js
  room.onPlayerJoin = (player) => {
    window.onPlayerJoinedRoom(player.auth, player.name);
  };

  room.onTeamGoal = (team) => {
    window.onGoalScored(team, lastToucher);
  };

  // itd.
}, roomConfig);

// W Node.js:
await page.exposeFunction("onPlayerJoinedRoom", (auth, name) => {
  statsModule.updatePlayer(auth, name);
});
```

### Tracking stanu meczu
W `page.evaluate()` trzeba śledzić:
- Aktualny stan gry (czy mecz trwa)
- Ostatnie dotknięcie piłki (gracz + timestamp)
- Skład zespołów (kto w Red, kto w Blue)
- Czas rozpoczęcia meczu
- Licznik czasu gry dla każdego gracza

---

## ⚙️ Konfiguracja

Na początek **hardcoded** w kodzie:
```javascript
const CONFIG = {
  ASSIST_TIME_WINDOW: 3000,  // 3 sekundy w ms
  RANK_LIMIT: 10,            // top 10 w !rank
};
```

Później można przenieść do `.env` lub `config.json`.

---

## 🚀 Plan implementacji

1. ✅ Utworzenie specyfikacji (ten plik)
2. Setup SQLite (schema, inicjalizacja)
3. Moduł `stats.mjs` (CRUD operations)
4. Tracking w `haxball.mjs`:
   - Player join/leave
   - Goal/assist detection
   - Match start/stop
   - Time tracking
5. Komendy w chacie
6. Testing & debugging

---

## 📝 Notatki

- Max ~10 graczy w pokoju
- Brak zmian składów w trakcie meczu (zazwyczaj)
- Overtime automatyczne → remis tylko gdy admin zakończy przy równym wyniku
- API Haxball stabilne od 2018, backward compatible

---

**Data utworzenia:** 2025-11-28
**Status:** Zatwierdzone, gotowe do implementacji
