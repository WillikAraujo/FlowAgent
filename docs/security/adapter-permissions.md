# ADE-104 — Política de permissões de adapters

**Status:** critérios preliminares; revisão do contrato de ADE-101/102 pendente.
**Regra de segurança:** nenhum estado vindo do agent/CLI pode aprovar uma solicitação ou ampliar permissões.

## Política padrão

1. Main invoca apenas CLI oficial detectado, com caminho/versão identificados, argv separado e sem shell intermediário.
2. Não habilitar flags/modos que removem prompts, bypassam sandbox ou ignoram aprovações por padrão.
3. `cwd` permitido é somente raiz de projeto ou worktree autorizada, canonicalizada e revalidada pelo Main na criação da execução.
4. Pedido de permissão do provider deve ser correlacionado à execução e convertido em `ApprovalRequest` persistida antes de qualquer decisão. UI deve mostrar ação, alvo, cwd e consequência em termos compreensíveis.
5. Somente ação humana explícita na UI pode aprovar ou negar. Resposta do agente, timeout, desconexão, retry, replay ou erro de persistência nunca aprovam. Falha de correlação/persistência/apresentação resulta em negar (fail-closed).
6. Capability só é `supported` quando o adapter consegue identificar e aplicar a restrição correspondente. `unsupported` e `unknown` não significam seguro, sandboxed ou restrito; não habilitam execução irrestrita silenciosa.
7. Processo usa identidade Windows do usuário. UI e documentação deixam claro que ADE não oferece isolamento forte no MVP e que o CLI pode acessar recursos disponíveis a esse usuário.

## Override permissivo

**Recomendação Sentinel para MVP: proibir totalmente.** Isso elimina um caminho de execução que pode remover proteções do provider sem que ADE tenha contenção equivalente.

Se decisão de produto/arquitetura exigir override futuro, ele deve ser por execução e exigir: capabilities afetadas exibidas como ausentes/desabilitadas; preview do comando, CLI, cwd e alcance; confirmação humana explícita imediatamente antes do spawn; motivo e decisão registrados como evento durável; nenhuma herança por perfil, projeto ou sessão. Sem esses requisitos, bloquear início. A aprovação de uma permissão pontual não deve habilitar modo permissivo global.

## Critérios verificáveis

- Matriz por provider/versão indica capacidades detectadas, mecanismo de enforcement e estado `supported|unsupported|unknown`.
- Teste prova que entrada do renderer não pode definir caminho de executável, flags de bypass, cwd fora do escopo ou decisão de approval sem validação no Main.
- Testes de fluxo provam que apenas ação humana explícita aprova; timeout, erro de armazenamento, reconexão e payload do agent negam ou mantêm pendente.
- Processo filho não recebe ambiente completo sem justificativa; nenhum token é lido/copied para banco, evento, log ou export por ADE.
- Cancelamento/encerramento alcança subprocessos; limites de output/duração/concorrência são aplicados pelo Main.
- UI diferencia restrição comprovada, capacidade não suportada e estado desconhecido; nenhum caso incerto aparece como sandbox.

## Achados/gates preliminares

| ID | Severidade | Impacto | Responsável | Remediação / aceite |
|---|---|---|---|---|
| ADE-104-A1 | P1 | Modo permissivo implícito pode desativar salvaguardas do CLI e executar efeitos de alto impacto como o usuário Windows. | Nexus (contrato adapter); Atlas (enforcement Main); Scribe (review) | Negar flags de bypass por padrão; para o MVP, bloquear override permissivo. Se excepcionalmente aprovado em decisão de produto, atender todos os requisitos de override acima. |
| ADE-104-A2 | P1 | Pedido não correlacionado ou falha de persistência pode virar aprovação acidental ou ser impossível de auditar. | Nexus (provider mapping); Atlas (persistência/IPC); Scribe (review) | ApprovalRequest persistida, correlacionada, fail-closed e aprovada somente por ação humana explícita; registrar decisão e resultado. |
| ADE-104-A3 | P1 | Capability `unknown`/`unsupported` apresentada como restrição permite execução sem contenção prometida. | Nexus (capability contract); Atlas (UI/API); Scribe (review) | Representar estados literalmente, documentar enforcement e não declarar sandbox sem enforcement verificável. |
| ADE-104-A4 | P1 | CLI/subprocessos executam com amplo acesso da identidade Windows e podem ler/gravar além do workspace. | Atlas (process model); Nexus (adapter); Scribe (review) | Comunicar acesso herdado; limitar cwd e ambiente, não alegar isolamento forte; registrar explicitamente o risco residual do MVP. |
| ADE-104-A5 | P1 | stdout/stderr e ApprovalRequest podem persistir tokens ou conteúdo sensível do workspace. | Nexus (adapter/redação); Atlas (eventos/evidências); Scribe (review) | Live-only para PTY por padrão; persistência apenas como evidência explícita com prévia; redação antes de duráveis/exportação e exclusão manual disponível. |

## Limite de garantia

Prompts e mecanismos próprios de um provider não provam confinamento do processo ou de ferramentas. O ADE não deve declarar que uma execução está sandboxed apenas porque o CLI oferece aprovação, modo seguro ou capability nominal; é necessário demonstrar qual controle é aplicado e qual fronteira ele protege.

## Estado da revisão

Pendente de ADE-101/102. Confirmar para cada adapter o caminho do executável, argv, cwd, ambiente, flags por padrão, fluxo de approval, cancelamento, capabilities e dados que persistem. Findings acima são gates preliminares, não vulnerabilidades confirmadas na implementação Electron.
