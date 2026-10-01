import { KnowledgeService } from './knowledge-service.ts';
import type { AgentPrincipal } from './agent-access-policy.ts';
import type { KnowledgeInput } from '../../domain/collaboration.ts';

export class DecisionsService {
  private readonly knowledge: KnowledgeService;
  constructor(knowledge: KnowledgeService) { this.knowledge=knowledge; }
  list(p: AgentPrincipal) { return this.knowledge.list(p, 'decision'); }
  propose(p: AgentPrincipal, input: KnowledgeInput) { return this.knowledge.create(p, 'decision', input); }
  validate(p: AgentPrincipal, id: string, revision: number) { return this.knowledge.transition(p, 'decision', id, revision, 'validate'); }
  accept(p: AgentPrincipal, id: string, revision: number, options: { replacementId?: string; justification?: string } = {}) { return this.knowledge.transition(p, 'decision', id, revision, 'accept', options); }
}
