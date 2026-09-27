# Matriz de aceite e evidências — ADE desktop local

**ADE-103 · Responsável: Verity · Reviewers: Atlas e Conduit**  
Esta matriz mapeia requisito → cenário verificável → camada → evidência exigida. “Gate” descreve critério futuro de homologação, não resultado já observado. Camadas: **U** unitário, **I** integração, **E2E** fluxo empacotado no Windows x64.

| Fase | Requisito | Cenário de aceite observável | Camada | Evidência/gate |
|---|---|---|---|---|
| Fundação | IPC rejeita canal desconhecido | Invocar canal não registrado; handler não roda e resposta é rejeição controlada | U + I | Resultado/assertion e log sem execução do handler; todos os canais enumerados no contrato |
| Fundação | IPC valida schema | Enviar payload inválido, versão desconhecida e payload no limite/fora do limite definido pela spec | U + I | Matriz de validação por schema/version; limite e resultado registrados |
| Fundação | Permission tests | Invocar operação sem permissão e com permissão; negativa não altera estado | U + I | Casos por operação/ator local; confirmar na spec os limites e modelo de permissão |
| Persistência | Contador, evento e revision atômicos | Falhar/crash antes do commit: nenhum é visível; crash depois do commit: evento existe e é recuperável | U + I | Estado do DB antes/depois, integridade, logs de fault injection; contagem sem lacunas |
| Persistência | `projectSequence` monotônica sem lacunas | Escritas concorrentes, rollback e restart; commits recebem sequência ordenada sem lacunas | U + I | Consulta ordenada de eventos e sequência; corrida reexecutável |
| Persistência | Revision monotônica por aggregate | Atualizações concorrentes, rollback e replay não reduzem nem duplicam revisão efetiva | U + I | Histórico aggregate/evento/revision e resultado de concorrência |
| Persistência | Persist-before-publish | Interromper após commit e antes da entrega; consumidor reinicia e obtém evento por replay | I | Traço commit→queda→replay; sem alegação exactly-once |
| Persistência | Dedup por `eventId` | Entregar o mesmo evento repetidas vezes após retry/replay; efeito de domínio aplicado uma vez | U + I | Eventos recebidos versus efeitos persistidos; entrega at-least-once documentada |
| Persistência | Replay cursor e snapshot em gap | Cursor válido continua em cursor+1; cursor futuro/inválido ou schema incompatível solicita snapshot; snapshot declara cursor | U + I | Request/response com cursor, snapshot e sequência inicial de replay |
| Persistência | Restart | Fechar abruptamente após commit; reiniciar e reconstruir estado via persistência/replay | I + E2E | Estado pré-fechamento versus pós-restart e logs do ciclo |
| Adaptadores | Auth/CLI ausente | CLI ausente, login local ausente, presente e estado indeterminado; sem leitura/persistência de segredos | U + I + E2E | Fakes por provedor, estados detectados e inspeção de DB/logs sem segredo |
| Execução | Cancel idempotente/cooperativo | Cancel repetido retorna estado atual; tarefa concluída permanece concluída; não há escalada automática | U + I | Estado/transições, chamadas e sinais enviados |
| Execução | Terminate grace + kill de árvore | `terminate` explícito aguarda grace; processo resistente e descendentes são encerrados após kill | I + E2E | PID/árvore antes/depois, tempos observados e ausência de filhos vivos |
| PTY/UI | Sequência e gap | Frames contíguos por `executionId` na conexão viva; reconexão sinaliza `output-gap`, não replay; terminal state indica encerramento | U + I + E2E | Transcript/frame sequence e estados UI antes/depois da reconexão |
| Git/worktree | Path escape/canonical/reparse | Tentar `..`, caminho externo, symlink/junction/reparse apontando fora e troca concorrente; operação mutável é negada | U + I | Paths canônicos e resultado; fixture isolada Windows; nenhuma mutação externa |
| Git/worktree | Dirty recheck | Projeto/worktree fica dirty ou muda após preview e antes da ação; execução bloqueia e requer preview atualizado | I + E2E | Snapshot preview, estado modificado e rejeição antes da mutação |
| Git/worktree | Bulk preview | Alterar conjunto/estado entre preview e confirmação; somente conjunto confirmado e ainda válido pode executar | U + I + E2E | Conteúdo do preview, confirmação e lista exata de resultados |
| Dados | Export SQLite/WAL | Escritas concorrentes; online backup contém todos os commits WAL confirmados até snapshot consistente | I | Integridade e contagem/chaves esperadas na cópia, incluindo WAL committed |
| Dados | Restore validado antes do swap | Restore íntegro valida em perfil de recuperação e troca; backup truncado/incompatível falha sem trocar perfil ativo | I + E2E | Hash/versão, validação pré-swap, identidade do perfil ativo antes/depois |
| Distribuição | Instalador Windows x64 | Instalação limpa em Windows x64, inicia app, registra versão/hash e desinstala/upgrade conforme suporte | E2E | Logs, versão/hash do pacote, SO/arquitetura, resultado do smoke |
| Distribuição | CLI local | Detecta CLIs locais presentes/ausentes por provedor sem impor credencial ADE; estado visível e diagnóstico acionável | I + E2E | Matriz fake/ambiente limpo e resultado por CLI; nenhum segredo em artefato |
| Distribuição | Backup/restart pós-upgrade | Exportar, instalar upgrade, reiniciar e verificar dados; restaurar backup em perfil isolado | E2E | Versões origem/destino, hash do backup, estado antes/depois e logs |
| Geral | Revisão devolvida | Evidência/teste devolvido por reviewer reabre item e impede gate de fase até correção ou exceção formal | Processo + U (se automatizado) | Registro da revisão, ação corretiva e nova evidência vinculada ao commit |
| Geral | Cenários mandatórios | Desconexão, reinício, mensagem duplicada, cancelamento, worktree pendente, acesso fora do projeto, revisão devolvida e backup recovery | Cobertura por fase | Índice requisito→teste→evidência; nenhum cenário fica sem dono/fase |

## Evidência mínima por execução posterior

- Identificador do requisito/cenário e fase; commit e build/installer hash.
- SO/arquitetura, pré-condições e fixture (sem dados/credenciais pessoais).
- Comando ou procedimento exato; resultado observado e esperado; logs, asserts ou artefatos relevantes.
- Limitações, defeitos conhecidos, revisão e decisão de aceite.
- Para crash/restart: ponto de injeção e estado recuperado. Para dados: hashes e verificações de integridade. Para processo/Git: PIDs, paths canônicos e estado antes/depois.

## Dependências e pendências

1. Spec deve fixar limites de payload, operações/permissões IPC, versões de schema/cursor e política de compatibilidade.
2. Confirmar implementação de backup online API na plataforma SQLite escolhida e procedimento para WAL committed/restore/swap.
3. Confirmar contrato Windows de canonicalização e identificação de junction/symlink/reparse, inclusive privilégio necessário para fixtures.
4. Definir CLIs/provedores e o significado testável de sessão autenticada sem acessar segredos; CLI ausente precisa ser testável em ambiente limpo.
5. Fixar grace period, timeout de kill e garantia de encerramento de árvore em Windows.
6. Atlas e Conduit devem revisar contratos e cobertura antes de transformar gates em aceite de release.

Alteração após aceite invalida os testes afetados. O ADE-103 apenas publica este plano; não executa testes e não constitui homologação da implementação.
