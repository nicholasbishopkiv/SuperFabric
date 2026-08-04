# Фабрика — итоги ресерча (2026-08-03)

Сжатая выжимка двух ресерч-проходов: механики Claude Code (по официальным докам) и
prior art / выбор стека (web-ресерч). Детали и ссылки — в конце.

> **Это датированный снимок ресерча, а не описание продукта.** Русский текст — оригинал, с
> которого переведён [RESEARCH.md](RESEARCH.md); **он не обновлялся с M1b**. Три вывода
> отсюда позже опровергнуты замерами, и в английском файле они помечены **[superseded]**:
> (1) логин — `claude auth login` **не требует TTY** вообще, никакого hidden-PTY и
> `node-pty` в продукте нет, а `claude setup-token` отвергнут (см. [решение
> 0004](decisions/0004-account-login-over-a-pipe.md)); (2) хранилище — не `better-sqlite3`,
> а `bun:sqlite` (см. [решение 0001](decisions/0001-bun-runtime-keep-vite.md));
> (3) usage-эндпоинт уже поменялся — актуальные формы полей в `RESEARCH.md` §2. Плюс
> «сериализовать refresh» так и осталось рекомендацией: этого нет.

## 1. Механики Claude Code, на которых строимся

- **Программное управление**: `claude -p` — one-shot; интерактивное многоходовое
  управление даёт только **Agent SDK** (`@anthropic-ai/claude-agent-sdk`): streaming
  input (AsyncIterable prompt), `interrupt()`, `setPermissionMode()`, `canUseTool`
  callback, `options.resume` / `forkSession`, in-process MCP (`createSdkMcpServer`).
  CLI-эквивалент (флаги Vibe Kanban): `claude -p --output-format=stream-json
  --input-format=stream-json --include-partial-messages --permission-prompt-tool=stdio`.
- **Изоляция аккаунтов**: `CLAUDE_CONFIG_DIR` переносит весь `~/.claude` (credentials +
  сессии). Linux: токены в `.credentials.json` (0600). Один каталог = один аккаунт;
  нельзя шарить между аккаунтами (refresh-токены перезаписываются на месте).
- **Login**: браузерный OAuth **не завершается в headless-контейнере** — логин делаем
  на хосте (hidden-PTY, паттерн AgentsRoom/Maestro) или `claude setup-token` (~годовой
  `CLAUDE_CODE_OAUTH_TOKEN`, Pro/Max).
- **Сессии**: JSONL в `<config-dir>/projects/<encoded-cwd>/<session-id>.jsonl`;
  `--resume <id>` / SDK `resume` работают после рестарта процесса/контейнера, пока файл
  жив. Форк: `forkSession: true`.
- **Пер-агентная конфигурация**: `--model`, `--append-system-prompt`,
  `--allowedTools/--disallowedTools`, `--permission-mode`, `--mcp-config`
  (+`--strict-mcp-config`), hooks, `.claude/agents/`. Всё дублируется в SDK options.
- **Контейнеры**: официальный референс — devcontainer-фича
  `ghcr.io/anthropics/devcontainer-features/claude-code` + `init-firewall.sh`
  (default-deny egress). `--dangerously-skip-permissions` официально благословлён именно
  внутри песочницы.
- **MCP-шина**: сессии — полноценные MCP-клиенты (stdio/HTTP/SSE/in-process). Push от
  сервера к агенту в MCP нет — но нам не нужен: наш сервер владеет input-стримом каждой
  сессии и «доставляет» сообщение инжектом нового turn'а.

## 2. Лимиты подписок

- Официального публичного API нет. **Но есть недокументированный
  `GET https://api.anthropic.com/api/oauth/usage`** (Bearer из `.credentials.json`,
  заголовок `anthropic-beta: oauth-2025-04-20`, User-Agent `claude-code/<ver>`,
  безопасный поллинг ~180с): возвращает `five_hour`, `seven_day`, `seven_day_opus`,
  `seven_day_sonnet` с `utilization` (0–100) и `resets_at`. Это те же данные, что у
  `/usage` в Claude Code — точные и кросс-девайсные. Риск: может измениться в любой
  момент → адаптер + fallback.

  **Поправка, замерено 2026-08-04 — уже изменилось.** `five_hour` и `seven_day` как описано,
  но `seven_day_opus` / `seven_day_sonnet` теперь возвращаются **`null`**; пер-модельные
  недельные цифры переехали в массив `limits[]` (`kind`: `session`/`weekly_all`/`weekly_scoped`,
  `percent`, `severity`, `resets_at`, `is_active`, у scoped — `scope.model.display_name`).
  Наш парсер читает обе формы, обе записаны фикстурами. Ровно тот риск, ради которого делался
  адаптер, — и он наступил через сутки после ресерча.
- Оценка по локальным JSONL (ccusage, Claude-Code-Usage-Monitor) принципиально неточна:
  лимиты динамические, кэш-токены взвешиваются непрозрачно, не видно других устройств.
  Использовать только для cost-аналитики.
- 5-часовое окно — скользящее от первого промпта; недельные капы (с авг 2025) — общий +
  отдельный Opus-бакет; авто-resume после сброса лимита в Claude Code **нет** — это
  наша работа (scheduler).

## 3. Prior art — что берём

| Откуда | Что берём | Лицензия |
|---|---|---|
| **Vibe Kanban** (sunset) | executor-абстракция над CLI, точные stream-json флаги, MsgStore (replay-then-tail) | Apache-2.0 |
| **Crystal** (deprecated) | session-as-first-class-object, SQLite-схема буферизации вывода | MIT |
| **CCManager** | детекция статусов busy/waiting/idle | MIT |
| **Happy Coder** | relay-дизайн для удалённого доступа/мобилы (на будущее) | MIT |
| **AgentsRoom / Maestro** | мульти-аккаунт: профиль на `CLAUDE_CONFIG_DIR`, in-app OAuth через hidden PTY | — |
| **Sculptor** | UX контейнер-на-агента + pairing mode | closed |
| **terragon-oss** | референс облачного раннера целиком | open snapshot |

Не трогаем: claude-squad (AGPL), claude-flow (сомнительная репутация), tldraw (лицензия).

**Рыночный вывод**: Terragon закрыт (02.2026), Vibe Kanban и Crystal свёрнуты — Anthropic
съел нишу облачных раннеров (Claude Code on the web, Agent Teams). Устойчивая ниша —
наша: self-hosted, мульти-аккаунт, пространственный UI.

## 4. Выбор стека (решения)

- **Canvas: react-three-fiber + drei (Three.js)** — по прямому продуктовому решению
  пользователя UI должен быть настоящей 3D-фабрикой (здания-цеха, конвейеры с
  коробками-сообщениями, позже анимированные агенты-человечки), а 2D-панели (taskpanel,
  метры лимитов, аппрувы) — DOM-слоем поверх WebGL-канваса. Всё MIT. Ресерч изначально
  рекомендовал @xyflow/react v12 (MIT, граф-модель) — решение заменено 3D-директивой;
  tldraw отклонён (проприетарная лицензия, watermark).
- **Транспорт: WebSocket** (двунаправленность: аппрувы/interrupt вверх по тому же
  каналу; мультиплекс N сессий в одном сокете). Событийный лог в SQLite — источник правды,
  сокет — lossy tail.
- **Хранилище: better-sqlite3 (WAL)** — единодушный выбор self-hosted prior art.
- **Docker: dockerode** + референсный firewall Anthropic (этап M4).

## 5. Риски / ToS

- Anthropic не разрешает третьим сторонам «предлагать логин claude.ai». Фабрика —
  персональный self-hosted инструмент: пользователь логинит **свои** аккаунты сам.
- Красная линия из крэкдауна конца 2025: пулинг/ротация аккаунтов для обхода лимитов
  (то, что делает ccflare). Сознательно не делаем; только мониторинг + пауза/resume.
- Формат ошибки 429/limit в headless не документирован — снять эмпирически в M0.
- Поведение конкурентного refresh токена при нескольких сессиях одного аккаунта не
  документировано — сериализуем refresh, мониторим.
