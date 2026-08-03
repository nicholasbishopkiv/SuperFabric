# Fabrica — контекст для агентов

Self-hosted визуальный оркестратор мульти-аккаунтных Claude Code агентов: 3D-фабрика в
браузере (react-three-fiber), комнаты-отделы = папки проекта, агенты = сессии Claude
Code (TS Agent SDK, streaming-input), MCP-шина между отделами, оркестратор, монитор
лимитов подписок с авто-паузой/resume.

## Перед любой работой прочитай

1. `docs/superpowers/specs/2026-08-03-fabrica-design.md` — канонический дизайн (EN).
2. `docs/ARCHITECTURE.md` — компоненты и потоки (EN).
3. `docs/ROADMAP.md` — на каком этапе (M0–M5) мы находимся.
4. `docs/RESEARCH.md` — факты о Claude Code / лимитах / prior art, чтобы не переоткрывать.

## Ключевые инварианты (не нарушать)

- Event-log в SQLite — источник правды; WebSocket — lossy tail с replay по `afterSeq`.
- Комната = папка; без Фабрики проект остаётся обычным репозиторием.
- Один `CLAUDE_CONFIG_DIR` = один аккаунт; никогда не шарить между аккаунтами.
- Доставка сообщений агентам — push (инжект turn'а в input stream), не polling.
- Никакого пулинга/ротации аккаунтов для обхода лимитов (ToS-линия) — только
  мониторинг, пауза и resume своих аккаунтов.

## Стек

pnpm workspaces · TypeScript · Node 22+ · Fastify + ws · better-sqlite3 (WAL) ·
`@anthropic-ai/claude-agent-sdk` · React 19 + Vite · react-three-fiber + drei · zustand ·
dockerode (M4). Лицензионная политика зависимостей: MIT/Apache only (не тянуть AGPL).

## Статус

Стадия дизайна: спека ждёт ревью пользователя. Код не начинать до утверждения спеки и
написания плана реализации M0.
