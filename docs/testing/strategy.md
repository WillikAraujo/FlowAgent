# Estratégia de qualidade e testes por fase — ADE desktop local

**ADE-103 · Responsável: Verity · Reviewers: Atlas e Conduit**  
**Escopo:** planejamento documental do Marco 1 e fases posteriores. Este documento define cobertura, camadas, fixtures e gates; não afirma execução de testes.

## Princípios

- Rastrear cada requisito a cenário verificável, camada apropriada e evidência conservada.
- Usar pirâmide: muitos testes unitários determinísticos de domínio/validação, integração para limites reais entre Main, SQLite, IPC, PTY, CLI e Git, e poucos fluxos E2E empacotados no Windows.
- Usar doubles e dados sintéticos para dependências externas; nenhuma credencial real em fixtures ou logs.
- Rodar suites por fase no Windows x64 e repetir gates de distribuição sobre o artefato candidato exato.
- Falha de crash deve ser injetada em pontos definidos antes/depois de commit. Testes de processo/instalador usam ambiente temporário e limpável.
- Exigir que testes dinâmicos posteriores registrem comando, commit/build, resultado observado, logs/artefatos, limitações e revisão. Alteração posterior invalida verificações afetadas.

## Contratos aceitos para orientar os testes

- `projectSequence`, evento durable e `aggregate revision` são gravados na mesma transação. Commit sem entrega ao consumidor recupera por replay: entrega at-least-once com dedup por `eventId`, sem promessa exactly-once.
- Snapshot declara `projectSequence` cursor. Replay retoma em `cursor + 1`. Cursor futuro/inválido ou schema incompatível força snapshot.
- PTY usa `streamSequence` contígua por `executionId` enquanto a conexão está viva. Reconexão emite `output-gap`, sem replay de frames; estado terminal informa encerramento.
- Cancel repetido retorna o estado atual e não afeta tarefa concluída. Cancel cooperativo não escala implicitamente. `terminate` é operação separada com grace period e kill da árvore de processos.
- SQLite export usa online backup API e inclui WAL committed. Restore valida em perfil de recuperação antes de swap.
- Limites e permission tests de IPC serão fixados na spec; gates dependentes deles permanecem condicionais até publicação dessa spec.

## Camadas, fixtures e evidências

### Unitários

Validar transições de estado, revisão/ordenação, validação de schemas, autorização por operação, dedup/replay, serialização, política de retries e cálculo de gaps. Sem sistema de arquivos ou relógio real quando um fake controlável servir.

### Integração

Exercitar SQLite real temporário, IPC/preload e Main, processos filhos PTY/CLI, Git real em repositórios temporários e APIs de backup. Confirmar contrato através do limite, não mockar o componente cujo comportamento se quer provar.

### E2E Windows

Poucos percursos de usuário em build instalada: iniciar, detectar CLI, abrir projeto, criar/retomar execução, observar stream e gap após reconexão, cancelar/encerrar, fechar/reabrir e recuperar backup. Instalar/atualizar/desinstalar em VM ou runner limpo x64.

### Fixtures reutilizáveis

- Banco/projeto temporários, migrations de cada versão suportada e conteúdo sintético para todas as entidades.
- Gerador de eventos com IDs repetidos, sequences concorrentes, revisões, cursor/snapshot e schemas antigos/desconhecidos.
- Fake CLI por provedor (Codex, Claude Code, Gemini CLI, OpenCode): ausente, instalada, sessão autenticada simulada, saída válida/inválida, timeout, desconexão, saída não zero e encerramento. Não capturar dados de perfil reais.
- Child process fake que registra sinais, filhos, grace timeout e kill; saída PTY controlável para desconexão/gap.
- Repositório Git descartável com branch, dirty worktree, junction/symlink/reparse point quando suportado, path externo e alterações entre preview e execução.
- Exportes SQLite: WAL com transações committed, operação de escrita concorrente, arquivo truncado e conteúdo/schema incompatível.
- Pacotes/artefatos assinados e instaladores construídos em CI, com hashes e logs de instalação.

## Plano e gates por fase

### Fase 1 — Fundação desktop

Cobrir renderer sem acesso direto a Node, validação de mensagens no preload/Main, canal desconhecido, schema/payload inválido, permissão negada, limite de payload definido na spec, ciclo de vida da janela e fechamento/reabertura. Unit para schema/autorização; integração para IPC real; E2E curto em build Windows.

**Gate:** nenhum canal desconhecido ou payload fora do schema é executado; operações sem permissão são negadas; interfaces IPC têm schema versionado e testes de contrato.

### Fase 2 — Domínio e persistência

Cobrir atomicidade de evento/contador/revisão, rollback, crash antes e depois do commit, restart, publicação perdida, replay at-least-once, dedup `eventId`, eventos repetidos/fora de ordem, cursor válido/futuro/inválido, snapshot e incompatibilidade de schema. Unit para regras; integração com SQLite para transação e recovery.

**Gate:** nenhuma lacuna de `projectSequence` em commits válidos; rollback não publica nem avança contador/revisão; commit recupera via replay; replay redelivered não duplica efeito; revisão monotônica; snapshot declara cursor e replay começa em cursor+1; cursor inválido/schema incompatível solicita snapshot.

### Fase 3 — Adaptadores e execução

Testar detecção e execução por cada CLI suportada: encontrada/ausente, autenticada/não autenticada/indeterminada, perfil, criar/retomar, envio, stream, cancelamento, terminate e capabilities. Simular auth local sem expor segredo. Cobrir cancel cooperativo repetido, após conclusão e em corrida com conclusão; `terminate` separado, grace, kill de toda a árvore, child que ignora sinal, processo já encerrado.

**Gate:** CLI ausente ou sessão não utilizável resulta em estado explícito e recuperável; credenciais nunca persistidas/expostas; cancel retorna estado atual idempotentemente e não afeta concluída; terminate respeita grace e não deixa filhos vivos após kill.

### Fase 4 — Centro visual

Testar lista operacional, detalhes, timeline, objetivo/backlog, bloqueios/decisões, reconexão e apresentação da saúde/capabilities. Frames de PTY são ordenados por `streamSequence` por execução na conexão viva; reconexão sinaliza `output-gap`, não inventa replay; terminal state comunica encerramento.

**Gate:** interface diferencia lacuna de saída de encerramento; não apresenta frames como contínuos quando houve gap; eventos repetidos não duplicam estado visível; ações em massa exigem preview/confirm conforme domínio.

### Fase 5 — Git e worktrees

Cobrir caminho canônico dentro/fora do projeto, `..`, symlink/junction/reparse point, case/Unicode/espaços no Windows, branch/base inválida, dirty, corrida após preview, path trocado por reparse point, remoção e concorrência. Revalidar canonicalização e dirty imediatamente antes de mutação. Para bulk: preview registra o conjunto/estado; confirmação só executa exatamente aquele conjunto e detecta mudança desde preview.

**Gate:** path escape e reparse fora do escopo autorizado são negados; estado dirty mudado após preview bloqueia e exige novo preview; sem force implícito; falha parcial informa itens concluídos/falhos e estado recuperável.

### Fase 6 — Qualidade e distribuição

SQLite export por online backup API com WAL committed durante escrita; abrir cópia e verificar integridade/dados; restore em perfil isolado, validar versão/schema/integridade antes de swap; falhas antes do swap preservam instalação original. Testar migrations suportadas, rollback/falha, restart após upgrade. Instalar x64 em Windows limpo, detectar CLIs locais ausentes/presentes, abrir projeto, encerrar/reabrir e validar backup/restore. Registrar versão e hash do artefato.

**Gate:** export contém todos os commits confirmados até o ponto consistente; restore inválido nunca substitui o perfil ativo; instalação x64 limpa inicia e executa smoke de disponibilidade dos CLIs sem exigir credencial do produto; upgrade preserva dados; instrução de rollback/recuperação documentada.

### Colaboração corporativa futura

Fora do MVP. Ao entrar no escopo, exigir novos gates de multiusuário, autorização por recurso, isolamento, auditoria, concorrência e retenção, revisados por Segurança antes de homologar.

## Critério geral de homologação

Uma fase fecha quando os requisitos nela previstos têm cenário aprovado na camada indicada, evidência reproduzível ligada ao commit e revisão registrada; falhas críticas/altas estão resolvidas ou formalmente aceitas no escopo. Os cenários obrigatórios da nota Qualidade e Evidências permanecem: desconexão, reinício, mensagem duplicada, cancelamento, worktree pendente, acesso fora do projeto, revisão devolvida e recuperação de backup. Nenhum teste deste plano foi executado como parte do ADE-103.
