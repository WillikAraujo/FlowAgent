# Avaliação técnica inicial

**Data:** 2026-09-26  
**Escopo:** leitura do repositório e das alterações locais presentes nesta avaliação. Não foi feita execução da aplicação, revisão de dependências ou validação dinâmica.

## Resumo executivo

O repositório contém um protótipo funcional em Node.js/Express com interface estática, gerenciamento Git worktree e terminais PTY via WebSocket. A base ainda não está pronta para uso corporativo ou exposição em rede: faltam autenticação, autorização, isolamento de comandos e controles operacionais. A prioridade recomendada é fechar a superfície de execução remota antes de ampliar funcionalidades.

## Estado do projeto

- Aplicação pequena, sem separação clara entre rotas, serviços e configuração.
- Não há documentação de uso, testes automatizados, lint ou pipeline de integração contínua preexistentes.
- O script `test` original falha intencionalmente por não haver testes configurados.
- Existem alterações locais não commitadas em `server.js` e `public/`, além de `worktreeManager.js` e `.maestri/` não rastreados. Elas foram consideradas trabalho em andamento e não foram alteradas nesta avaliação, exceto `package.json` para adicionar comandos de execução e checagem.
- A interface atual permite abrir múltiplos terminais e criar/remover worktrees; deve ser tratada como ferramenta de desenvolvedor com poder de execução no host.

## Riscos prioritários

| Prioridade | Achado | Impacto | Direção de correção |
|---|---|---|---|
| Crítica | Rotas HTTP e WebSocket não exigem autenticação ou autorização. | Qualquer cliente que alcance a porta pode criar terminais e executar comandos com as permissões do processo Node. | Restringir a interface a loopback por padrão; exigir identidade/autorização antes de qualquer acesso remoto; vincular sessões WebSocket à mesma identidade. |
| Crítica | CORS é aberto globalmente e não há proteção contra requisições de origem cruzada. | Um site externo pode tentar acionar operações privilegiadas no navegador de um usuário com a aplicação aberta. | Remover CORS amplo, validar `Origin` e implementar proteção CSRF adequada ao mecanismo de sessão. |
| Alta | `cwd` e `shell` enviados ao criar terminal são aceitos sem validação; `/api/repo/set` aceita caminho arbitrário. | Permite operar fora do repositório pretendido e escolher executáveis/shells sob a identidade do servidor. | Permitir somente caminhos registrados/permitidos, validar existência e limites, e não aceitar shell arbitrário. |
| Alta | Comandos Git são montados como strings e executados por `child_process.exec`. | Nomes de branch e caminhos podem quebrar o quoting e injetar argumentos/comandos; saída também não tem limites explícitos. | Migrar para `execFile`/`spawn` com argumentos separados, validar refs Git e limitar tempo/saída. |
| Alta | WebSocket aceita entrada e redimensionamento sem limites e mantém processo e buffer em memória. | Um cliente pode enviar dados excessivos ou controlar qualquer terminal identificado, causando abuso de recursos e acesso ao shell. | Autenticar associação terminal/usuário, limitar payloads, conexões e quantidade de processos; encerrar processos órfãos. |
| Média | Dados da aplicação são inseridos em `innerHTML` no cliente. | Valores de branch/caminho controláveis podem causar XSS armazenado ou refletido na interface. | Construir elementos com `textContent`, validar dados e aplicar Content Security Policy. |
| Média | Sem testes, logs estruturados, health checks ou política de dependências. | Regressões e falhas operacionais são difíceis de detectar e auditar. | Criar testes para rotas/serviços, health/readiness, logs sem segredos, revisão de dependências e fluxo de release. |

## Plano sugerido

1. **Conter exposição:** bind em `127.0.0.1`, remover CORS aberto e documentar que o modo atual é single-user/local.
2. **Fechar execução:** validar repositórios e diretórios permitidos; substituir comandos shell montados por chamadas com argumentos; proteger REST e WebSocket com autenticação/autorização.
3. **Construir qualidade:** adicionar testes unitários e de integração cobrindo criação/remoção de worktrees, validação de paths, APIs e ciclo de vida do PTY; adotar lint e cobertura mínima acordada.
4. **Operar com segurança:** limites de recursos, encerramento limpo, logs auditáveis, gestão de segredos, dependências atualizadas e instruções de resposta a incidentes.
5. **Preparar colaboração:** documentar modelo de ameaça, papéis, retenção de logs, revisão obrigatória e política de releases.

## Base de avaliação adicionada

- `npm start`: inicia o servidor.
- `npm run check`: valida sintaxe JavaScript dos arquivos centrais.
- `.github/workflows/quality.yml`: executa instalação reproduzível e checagem estática em PRs e pushes.

Essa checagem é apenas uma barreira inicial; não substitui testes, revisão de segurança ou homologação. Nenhum teste foi criado ou executado nesta avaliação.
