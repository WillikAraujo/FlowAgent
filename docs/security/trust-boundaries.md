# ADE-104 — Trust boundaries e critérios de revisão

**Status:** preparação de critérios; revisão de ADE-101/102 pendente.
**Escopo:** fundação desktop local Windows. Este documento não atesta controles implementados.

## Modelo de confiança

- Renderer é conteúdo não confiável, inclusive dados vindos de projetos, tarefas, CLIs e eventos.
- Main é autoridade para filesystem, SQLite, processos, PTYs, Git/worktrees, autorização e persistência de eventos.
- Preload é uma ponte mínima, não uma camada de autorização. Nenhuma API Node/Electron genérica atravessa para renderer.
- CLI autenticado e seus subprocessos operam como o usuário Windows. ADE não fornece isolamento forte no MVP e não deve alegar sandbox sem enforcement verificável.
- Arquivos de projeto, saída de agentes e resultados de ferramentas podem conter instruções hostis, caminhos, conteúdo executável ou dados sensíveis.

## Critérios verificáveis de aceite

### Main, Electron e IPC

1. `BrowserWindow` mantém `contextIsolation: true`, `nodeIntegration: false` e sandbox habilitado; CSP não permite script inline/eval sem justificativa documentada.
2. Navegação e abertura de janelas são restritas; conteúdo externo não ganha ponte privilegiada.
3. Preload expõe métodos específicos com tipos/schemas; não expõe `ipcRenderer`, `require`, `fs`, `child_process`, shell, SQL ou canal IPC arbitrário.
4. Main valida payload, estado, ownership/escopo e autorização em cada chamada. IDs recebidos do renderer são referências não confiáveis e revalidados no Main.
5. Operações longas têm limites de payload/ritmo e cancelamento; operações concorrentes não ultrapassam limites por checagem não atômica.

### Paths, cwd, reparse points e worktrees

1. Main canonicaliza raízes e cwd antes de cada operação; rejeita caminhos fora das raízes autorizadas.
2. Verificação lida com junctions/symlinks/reparse points e TOCTOU: caminho final aberto/executado deve continuar dentro da raiz, não apenas a string previamente validada.
3. Caminhos de worktree derivam do registro do Main/Git, não de autoridade fornecida pelo renderer/agent.
4. Testes de aceite cobrem traversal, drive-relative paths, UNC/device paths quando aplicável, junction para fora da raiz e substituição concorrente do destino.

### Processos, PTY e CLIs

1. Main inicia somente executável oficial detectado, com argv separado e sem shell intermediário; resolução do executável e versão ficam visíveis/auditáveis.
2. cwd é raiz do projeto ou worktree autorizada, revalidada no instante da criação.
3. Ambiente do processo é allowlist/minimizado; tokens e variáveis não necessárias não são copiados para processos auxiliares ou logs.
4. Existe política explícita para timeout, cancelamento, encerramento de árvore de processos, concorrência e limites de stdout/stderr/PTY.
5. O produto informa que os subprocessos herdam identidade e permissões Windows do usuário; não promete isolamento forte no MVP.

### SQLite, eventos e evidências

1. Apenas Main acessa SQLite; queries são parametrizadas e migrações versionadas/transacionais.
2. Eventos duráveis têm IDs/sequência/revisão definidos pelo Main; entradas originadas por agente não podem forjar aprovação ou sequência autoritativa.
3. Redação ocorre antes da persistência de eventos, telemetria e evidências, com limites documentados e sem alegar detecção perfeita de segredos.
4. stdout/stderr são live-only por padrão. Persistir como evidência exige ação explícita, prévia do conteúdo/destino e registro de quem/quando; export inclui apenas evidências selecionadas e nunca credenciais intencionalmente.
5. Dados duráveis sem expiração automática continuam sujeitos a exclusão manual e política de proteção/backup. Restore reabre snapshot com versão de schema identificada.

## Achados/gates preliminares

Estes pontos são riscos a verificar quando ADE-101/102 estiverem disponíveis, não constatações da implementação Electron.

| ID | Severidade | Impacto | Responsável | Remediação / aceite |
|---|---|---|---|---|
| ADE-104-G1 | P1 | Uma chamada IPC permissiva pode transformar renderer comprometido em deputy para executar processos ou acessar arquivos como o usuário. | Atlas (arquitetura Main/IPC); Scribe (review) | Demonstrar API de capacidades mínima, validação e autorização no Main; cobrir chamadas forjadas e renderer comprometido em testes de integração. |
| ADE-104-G2 | P1 | Junction/reparse point e TOCTOU podem escapar de cwd validado e permitir leitura/escrita/execução fora do projeto. | Atlas (paths/worktrees); Scribe (review) | Resolver e proteger o destino efetivo no uso, detectar links/reparse points e provar rejeição de escape em testes Windows. |
| ADE-104-G3 | P1 | CLI herda identidade/permissões do usuário; flags permissivas ou prompts ausentes podem permitir ações de alto impacto sem isolamento ADE. | Nexus (política/adapters); Scribe (review) | Default deny a bypass; capability unknown/unsupported não implica restrição; aprovação fail-closed e override apenas por execução, com preview e registro. Preferência de segurança: proibir overrides permissivos no MVP. |
| ADE-104-G4 | P1 | Credenciais locais podem vazar por ambiente, stdout/stderr, eventos duráveis, evidências ou exportações. | Nexus (adapters); Main/persistência — Atlas; Scribe (review) | ADE não coleta nem persiste credenciais intencionalmente; minimizar ambiente, redigir antes de persistir/exportar e testar padrões de segredo. Documentar limite de detecção incompleta. |
| ADE-104-G5 | P1 | Limites só na UI ou encerramento apenas do processo pai permitem abuso de recursos e subprocessos órfãos. | Atlas (process lifecycle); Scribe (review) | Aplicar limites no Main e encerrar a árvore; validar concorrência, output, duração e cancelamento em condições de falha. |
| ADE-104-G6 | P2 | Sem enforcement forte, usuário pode interpretar aprovação do CLI como sandbox/garantia de contenção que ADE não oferece. | Atlas (arquitetura/UX); Nexus (capability contract); Scribe (review) | Expor capability como unsupported/unknown quando enforcement não é demonstrável; declarar a identidade Windows herdada e o risco residual. Não usar rótulo “sandbox” sem prova de enforcement. |

## Dependências e contrato com áreas

- Atlas: processos Electron, IPC, persistência, canonicalização e ciclo de vida de processos.
- Nexus: contrato de capacidades dos adapters, prompts/aprovações, override e detecção de CLI.
- Conduit: fluxos de preview/confirmação e registro de ações humanas, se aplicável.
- Scribe: revisão independente após ADE-101/102; cada finding final deve incluir evidência, severidade, impacto, responsável e remediação.

## Estado da revisão

Na preparação deste documento, a árvore disponível ainda contém o protótipo Node/Express/PTY e não contém uma fundação Electron ou artefatos identificáveis de ADE-101/102. Não foi possível confirmar os controles acima. Reabrir esta checklist após ADE-101/102 e converter cada gate em finding confirmado ou aceite com evidência.
