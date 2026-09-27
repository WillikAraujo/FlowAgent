# ADE-102 — domínio e SQLite event store

## Limite do cartão

Persistência local de Project, Agent, AgentProfile, Task, Session, Execution, Note, Decision, Approval, Evidence metadata e DomainEvent. Este módulo não integra Electron IPC, PTY, CLI providers, Git/worktrees ou renderer.

## Contrato

- eventId é UUID e chave de deduplicação.
- sequence é monotônica por projeto, atribuída dentro de BEGIN IMMEDIATE; revision é monotônica por entidade/agregado.
- Estado da entidade, revision, sequência e evento são confirmados na mesma transação. commit() só retorna após COMMIT; o chamador só pode publicar depois do retorno.
- Repetir o mesmo eventId e conteúdo retorna o evento já gravado. Reutilizar eventId para conteúdo diferente falha.
- Leitura ordena por sequence, limita o lote e sinaliza resync para cursor futuro ou sequência ausente. Eventos duráveis não são podados automaticamente.
- expectedRevision oferece controle otimista; revisão 0 significa entidade ainda inexistente.

## Conteúdo permitido

Schemas recusam chaves de segredos, tokens, credenciais, variáveis de ambiente, stdout/stderr, PTY, transcript e output terminal; padrões conhecidos de credenciais, inclusive `token=valor`, `access_token=valor` e `refresh_token=valor` dentro de strings permitidas, são redigidos para [REDACTED] antes de persistir. Evidence contém metadados tipados somente (artifactType, displayName, uri, sha256, mediaType, sizeBytes, sourceLabel), nunca bytes ou texto do artefato. Uma validação por padrões não identifica todo segredo possível; os chamadores devem encaminhar somente dados de domínio permitidos.

## SQLite, migration, backup e restore

SQLite usa o módulo node:sqlite do runtime, foreign keys, WAL, synchronous=FULL e migrations versionadas com down migration. O handle DatabaseSync fica em campo ECMAScript privado `#db`; a API pública de leitura não expõe SQL e backup online passa por `backupSnapshotTo()`. O lock de export é indexado por caminho canônico (realpath, com normalização de caixa no Windows), portanto diferentes instâncias ADE do mesmo arquivo compartilham busy. sqlite.backup() cria cópia online incluindo commits no WAL; export filtra Evidence pela seleção explícita projectId + evidenceId, mantendo o histórico durável de eventos. Enquanto o backup copia, o event store rejeita writes feitos por seu único método de escrita (commit()) com PersistenceBusyError retriable. A escrita anterior de relação foi removida; o schema novo não cria tabela entity_relations e não há API mutadora fora de commit(). Testes verificam que uma segunda instância para o mesmo arquivo recebe busy durante export e que entity/event/sequence/revision/snapshot/replay não mudam. Restore valida integrity_check, foreign_key_check, versão atual exata, estrutura de colunas/chaves/índices e DDL integral da versão suportada antes de copiar para um destino inexistente; não substitui o perfil ativo.

A implementação depende de node:sqlite e sqlite.backup() presentes no runtime empacotado. Nenhum export/restore sobrescreve silenciosamente destino existente.

## Evidência de validação (2026-09-26)

- `npm.cmd run test:ade102` — PASS; 15 testes, 15 aprovados, 0 falhas. Inclui redação e inspeção dos valores crus no DB/export, busy durante export sem divergência de cursor/snapshot/replay, schema futuro e schema incompatível.
- `npm.cmd exec -- tsc -p tsconfig.electron.json --noEmit` — PASS; typecheck shell sem emissão.
- `npm.cmd exec -- tsc --noEmit --target ES2022 --module commonjs --moduleResolution node --types node --strict --skipLibCheck --rewriteRelativeImportExtensions src/main/persistence/index.ts src/main/persistence/sqlite-store.ts src/main/persistence/backup.ts src/main/persistence/migrations.ts src/main/persistence/database-gate.ts src/domain/model.ts src/shared/contracts/domain.ts` — PASS; typecheck explícito do event store/persistência.
- `node --version` — `v24.15.0`.
- `node -e "import('node:sqlite').then(m => console.log(JSON.stringify({DatabaseSync:typeof m.DatabaseSync, backup:typeof m.backup, node:process.version})))"` — `{"DatabaseSync":"function","backup":"function","node":"v24.15.0"}`. Os testes de integração executam backup/export e restore no Node local.
- `npm.cmd run build:electron` — FAIL na emissão para `dist/main/index.js`, `dist/preload/index.js` e `dist/shared/contracts/ipc.js`, com `TS5033`/`EPERM` ao abrir arquivos de destino. O `--noEmit` passa; a emissão/build de desktop continua bloqueada por permissão no diretório dist.
- Limitação: o runtime Node 24 valida a API SQLite local, mas não prova a compatibilidade da versão de Node embutida no Electron empacotado. Esse smoke/runtime do Electron e a revisão read-only final de Scribe continuam pendentes; ADE-102 permanece BLOCKED e não pronto.

## P1 residual — handle SQL e lock por arquivo (2026-09-26)

- Finding Scribe: `readonly db: DatabaseSync` ainda expunha escrita SQL fora de `commit()`, e lock baseado em WeakSet por handle não cobria outra instância do mesmo arquivo.
- Remediação: `#db` privado sem getter SQL; método `backupSnapshotTo()` mantém o handle dentro do event store; locks partilhados por chave de caminho real/canônico e normalizado para Windows. Construtores no mesmo arquivo também recusam abrir durante export.
- Regressão: abrir duas instâncias do mesmo SQLite, iniciar export numa e tentar commit pela outra; a segunda recebe PersistenceBusyError e sequence, revision, event count, entidade, snapshot e replay ficam iguais. Verificado também que `"db" in store` é falso.
- Evidência reexecutada após remediação: `npm.cmd run test:ade102` PASS 15/15; typecheck explícito de persistência PASS; build Electron segue FAIL por TS5033/EPERM em `dist`. Gate Scribe e runtime empacotado pendentes; ADE-102 continua BLOCKED.

## Revalidação reproduzível e diagnóstico do destino `dist` (2026-09-26)

- `npm.cmd run test:ade102` — PASS, 15/15 testes. Inclui DB/export, lock de export com segunda instância do mesmo arquivo e integridade de replay/snapshot.
- Typecheck explícito de persistência — PASS: `npm.cmd exec -- tsc --noEmit --target ES2022 --module commonjs --moduleResolution node --types node --strict --skipLibCheck --rewriteRelativeImportExtensions src/main/persistence/index.ts src/main/persistence/sqlite-store.ts src/main/persistence/backup.ts src/main/persistence/migrations.ts src/main/persistence/database-gate.ts src/domain/model.ts src/shared/contracts/domain.ts`.
- `node --experimental-strip-types --test --test-name-pattern="restore rejects future schema versions|online export filters unselected Evidence" tests/persistence/store.test.mjs` — PASS, 2/2; cobre export online/WAL, filtro de Evidence e restore validado/rejeição de schema incompatível.
- Build diagnóstico seguro — `tsc -p tsconfig.electron.json --outDir <diretório-único-em-%TEMP%>` PASS, emitindo somente no diretório temporário `C:\Users\adswi\AppData\Local\Temp\ade102-build-diagnostic-a045d2d822624fb383e03f40a0bffac2`; `dist` não foi escrito, removido nem sobrescrito.
- Inspeção read-only: `dist` é diretório; arquivos de saída existentes têm atributo `Archive`, não `ReadOnly`; `icacls` mostra ACL herdada com `Modify` para SID do sandbox/grupo e usuário local. Nenhum processo com nome node/electron/tsc apareceu na consulta WMI. Essas observações não provam ausência de handles fora da visibilidade do sandbox.
- Diagnóstico: a compilação completa passa quando o destino é gravável; o `TS5033`/`EPERM` registrado em `dist` é específico da emissão no destino existente, não uma falha de typecheck. Como repetir emissão em `dist` poderia substituir arquivos existentes, o build normal não foi reexecutado neste diagnóstico. A causa última entre política de sandbox e bloqueio externo de arquivo permanece não determinada.
- Limites: testes/backup restore passam no Node local 24.15.0; runtime Electron empacotado não foi exercitado. ADE-102 continua BLOCKED, aguardando Scribe e evidência runtime/build no ambiente autorizado.

## Checkpoint reprodutível ADE-102 — retomada (2026-09-26)

- Ambiente observado: Windows; `node --version` → `v24.15.0`; `npm.cmd --version` → `11.13.0`; `npm.cmd exec -- electron --version` → `v37.10.3`.
- `npm.cmd run test:ade102` → exit 0; `tests 15`, `pass 15`, `fail 0`, duração reportada `1184.0059ms`. A saída integral mostrou todos os 15 subtestes aprovados; avisos `MODULE_TYPELESS_PACKAGE_JSON` não falharam a suíte.
- `npm.cmd exec -- tsc --noEmit --target ES2022 --module commonjs --moduleResolution node --types node --strict --skipLibCheck --rewriteRelativeImportExtensions src/main/persistence/index.ts src/main/persistence/sqlite-store.ts src/main/persistence/backup.ts src/main/persistence/migrations.ts src/main/persistence/database-gate.ts src/domain/model.ts src/shared/contracts/domain.ts` → exit 0, sem diagnósticos.
- Compilação Electron sem tocar em `dist`: `npm.cmd exec -- tsc -p tsconfig.electron.json --outDir C:\Users\adswi\AppData\Local\Temp\ade102-build-checkpoint-bb75648dd88e4055b00a132b9c370348` → exit 0. Manifesto gerado: `main/index.js`, `preload/index.js`, `shared/contracts/ipc.js`, todos sob esse diretório temporário.
- Script de build declarado reproduzido com saída segura: `npm.cmd run build:electron -- --outDir C:\Users\adswi\AppData\Local\Temp\ade102-build-script-4d694a1880c04db08982d86e62ff0d63` → exit 0 (`tsc -p tsconfig.electron.json --outDir ...`). Manifesto: `main/index.js` (5733 bytes), `preload/index.js` (721 bytes), `shared/contracts/ipc.js` (4216 bytes). Isso valida a entrada do script e emissão para destino novo; não prova emissão no `dist` existente.
- Smoke de runtime isolado: `npm.cmd exec -- electron "C:\Users\adswi\AppData\Local\Temp\ade102-electron-sqlite-36ee1bcfebba45efa999dc2bd101dd66\smoke.cjs"` → exit 0. JSON integral: `{"electron":"37.10.3","node":"22.21.1","sqlite":"138.0.7204.251","databaseSync":"function","backup":"function","restoredRow":{"id":1,"value":"electron-node-sqlite-ok"},"sourceBytes":8192,"backupBytes":8192}`. Apenas aviso stderr de SQLite experimental. Script, DB fonte e backup ficaram no diretório descartável em `%TEMP%`; valida runtime Electron instalado e API backup básica, não valida app ADE empacotado nem integrações Main/IPC.
- Regressão direcionada de export/restore: `node --experimental-strip-types --test --test-name-pattern="restore rejects future schema versions|online export filters unselected Evidence" tests/persistence/store.test.mjs` → exit 0, 2/2 aprovados.
- Diagnóstico anterior `TS5033`/`EPERM`: o registro disponível identifica falha ao abrir `dist/main/index.js`, `dist/preload/index.js` e `dist/shared/contracts/ipc.js`, porém a saída integral original com mensagem detalhada/stack não foi preservada neste workspace. Não repetimos `build:electron` para `dist`, pois existem artefatos nesse diretório e a emissão poderia substituí-los. A compilação ao `outDir` temporário passa.
- Inspeção read-only confirmou arquivos existentes em `dist` com atributo `Archive` e ACL mostrando `Modify` para SID do sandbox/usuário e `FullControl` para usuário local. A consulta de processos também observou uma instância Electron/dev do ADE ativa (`concurrently`, Vite e `electron .`); não foi parada nem investigada por handle para preservar estado do usuário. Esses dados não distinguem definitivamente lock externo, processo em execução ou política do sandbox; causa raiz do EPERM segue indeterminada.
- Nenhuma mudança foi feita em `package.json`, scripts, tsconfig, Electron/Main/preload/IPC compartilhados ou `dist`. ADE-102 segue BLOCKED: falta build reproduzível no destino oficial sem risco a artefatos e smoke empacotado do ADE, além da revisão Scribe.

## Harness CJS de persistência no runtime Electron (2026-09-26)

- Objetivo: exercitar os módulos reais de `src/main/persistence/**` no runtime Electron instalado sem tocar `dist`, package/config/contratos compartilhados ou dados do projeto.
- Ambiente: Windows; Electron `37.10.3`; Node embutido `22.21.1`; SQLite `138.0.7204.251`.
- Compilação CJS real (exit 0): `npm.cmd exec -- tsc --target ES2022 --module commonjs --moduleResolution node --types node --strict --skipLibCheck --rootDir src --outDir C:\Users\adswi\AppData\Local\Temp\ade102-real-electron-harness-b5f44d9a37344054a4e15152b462d577\compiled --rewriteRelativeImportExtensions src/main/persistence/index.ts`.
- Execução real no Electron (exit 0): `C:\Users\adswi\ade-core\node_modules\electron\dist\electron.exe --no-sandbox C:\Users\adswi\AppData\Local\Temp\ade102-real-electron-harness-b5f44d9a37344054a4e15152b462d577\harness.cjs`.
- stdout JSON: `{"ok":true,"electron":"37.10.3","node":"22.21.1","sqlite":"138.0.7204.251","databaseSync":"function","projectEventSequence":1,"taskEventSequence":2,"evidenceEventSequence":3,"duplicateEventSequence":2,"integrity":"ok","foreignKeyViolations":0,"counts":{"projects":1,"entities":2,"events":3,"evidence":1,"sequence":3,"taskTitle":"Safe temporary task","replaySequences":[1,2,3]},"paths":{"tempRoot":"C:\\Users\\adswi\\AppData\\Local\\Temp\\ade102-real-electron-harness-b5f44d9a37344054a4e15152b462d577","compiledPersistence":"C:\\Users\\adswi\\AppData\\Local\\Temp\\ade102-real-electron-harness-b5f44d9a37344054a4e15152b462d577\\compiled\\main\\persistence","harness":"C:\\Users\\adswi\\AppData\\Local\\Temp\\ade102-real-electron-harness-b5f44d9a37344054a4e15152b462d577\\harness.cjs","sourcePath":"C:\\Users\\adswi\\AppData\\Local\\Temp\\ade102-real-electron-harness-b5f44d9a37344054a4e15152b462d577\\source.sqlite","exportPath":"C:\\Users\\adswi\\AppData\\Local\\Temp\\ade102-real-electron-harness-b5f44d9a37344054a4e15152b462d577\\export.sqlite","restorePath":"C:\\Users\\adswi\\AppData\\Local\\Temp\\ade102-real-electron-harness-b5f44d9a37344054a4e15152b462d577\\restored.sqlite"}}`.
- stderr integral: `(node:55980) ExperimentalWarning: SQLite is an experimental feature and might change at any time` seguido de `(Use `electron --trace-warnings ...` to show where the warning was created)`. Nenhum outro erro.
- Cobertura: cria DB e aplica migration na abertura; grava project, task e Evidence metadata segura; repetir o mesmo `eventId` retorna a mesma sequência; replay por cursor retorna [1,2,3]; export online com seleção explícita de Evidence; restore para destino inexistente; valida `integrity_check=ok`, zero FKs quebradas e task title restaurado. Nenhum segredo ou conteúdo terminal foi usado.
- Artefatos temporários preservados para inspeção Scribe em `C:\Users\adswi\AppData\Local\Temp\ade102-real-electron-harness-b5f44d9a37344054a4e15152b462d577`: `harness.cjs`, `electron.stdout.txt`, `electron.stderr.txt`, `source.sqlite`, `export.sqlite`, `restored.sqlite`; CJS compilado em `compiled\domain\model.js`, `compiled\main\persistence\{index,backup,database-gate,migrations,sqlite-store}.js`, `compiled\shared\contracts\domain.js`. Os diretórios temporários internos de staging usados e removidos pela API de export/restore não permaneceram.
- Este resultado comprova compatibilidade funcional básica dos caminhos event store/backup/restore no runtime Electron instalado, usando CJS do source atual. Não é smoke do ADE empacotado nem resolve o `TS5033`/`EPERM` do build para `dist`; nenhuma saída de build foi escrita em `dist`. O checkpoint foi enviado ao Nexus para relay Scribe read-only. ADE-102 continua BLOCKED até gate build oficial e aceite Scribe.

## Recuperação e limitações

A migration atual tem down migration destrutiva, destinada a ambiente vazio/teste; antes de downgrade de dados reais, exigir backup validado. Se uma migração futura não puder ser revertida com segurança, criar DB/perfil novo, validar e preservar a cópia anterior. A validação baseada em padrões não prova ausência universal de segredos. A seleção de Evidence não reescreve o event log nem cria lacunas de sequence.


