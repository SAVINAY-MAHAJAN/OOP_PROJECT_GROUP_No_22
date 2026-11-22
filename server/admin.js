import {
  role,
  choice,
  boolean,
  integer,
  levels,
  priorities,
  priorityStrategies,
  strategies,
  requireThat,
  text,
  words,
} from './validation.js';
import { technicianFields } from './accounts.js';

export async function manageUser(unit, actor, id, input) {
  role(actor, 'ADMINISTRATOR');
  const user = await unit.users.byId(id);
  requireThat(user, 'Record could not be found.', 404);
  if (input.active !== undefined) {
    const active = boolean(input.active, 'Active');
    requireThat(active || actor.id !== id, 'You cannot deactivate your own account.');
    if (active === user.active) return user.publicProfile();
    const changed = await unit.users.findAndUpdate(
      { _id: id },
      { $set: { active }, $inc: { authVersion: 1 } },
    );
    if (!active) await unit.sessions.deleteMany({ userId: id });
    return { ...user.publicProfile(), active: changed.active };
  }
  requireThat(user.role === 'TECHNICIAN', 'Choose a technician.');
  const fields = technicianFields(input);
  await unit.users.update({ _id: id }, { $set: fields });
  return { ...user.publicProfile(), ...fields };
}

export async function saveService(unit, actor, id, input) {
  role(actor, 'ADMINISTRATOR');
  const policy = text(input.policy, 'SLA policy', 0, 80) || null;
  const defaultCategory = text(input.defaultCategory, 'Default category', 0, 40) || null;
  if (policy) await unit.policies.get(policy);
  if (defaultCategory) {
    const updated = await unit.categories.update(
      { _id: defaultCategory },
      { $inc: { referenceRevision: 1 } },
    );
    requireThat(updated.matchedCount, 'Category could not be found.', 404);
  }
  const fields = {
    name: text(input.name, 'Service name', 2, 60),
    description: text(input.description, 'Description'),
    criticality: choice(input.criticality, levels, 'business criticality'),
    policy,
    defaultCategory,
  };
  if (id) {
    const saved = await unit.services.findAndUpdate({ _id: id }, { $set: fields });
    requireThat(saved, 'Record could not be found.', 404);
    return saved;
  }
  id = await unit.counters.next('SVC');
  const service = { _id: id, id, ...fields };
  await unit.services.insert(service);
  return service;
}

export async function saveCategory(unit, actor, id, input) {
  role(actor, 'ADMINISTRATOR');
  const fields = {
    description: text(input.description, 'Description'),
    keywords: [...new Set(words(input.keywords, 'keywords').map((value) => value.toLowerCase()))],
  };
  if (id) {
    const saved = await unit.categories.findAndUpdate({ _id: id }, { $set: fields });
    requireThat(saved, 'Record could not be found.', 404);
    return saved;
  }
  id = text(input.name, 'Category name', 2, 40);
  requireThat(!(await unit.categories.one({ _id: id })), 'This category already exists.', 409);
  const category = { _id: id, id, name: id, ...fields };
  await unit.categories.insert(category);
  return category;
}

export async function savePolicy(unit, actor, id, input) {
  role(actor, 'ADMINISTRATOR');
  const targets = {};
  for (const priority of priorities) {
    const target = input.targets?.[priority];
    const responseMinutes = integer(target?.responseMinutes, priority + ' response', 1, 525600);
    const resolutionMinutes = integer(target?.resolutionMinutes, priority + ' resolution', 1, 525600);
    requireThat(
      responseMinutes <= resolutionMinutes,
      'Response target cannot exceed resolution target.',
    );
    targets[priority] = { responseMinutes, resolutionMinutes };
  }
  const fields = { name: text(input.name, 'Policy name', 2, 40), targets };
  if (id) {
    const saved = await unit.policies.findAndUpdate({ _id: id }, { $set: fields });
    requireThat(saved, 'Record could not be found.', 404);
    return saved;
  }
  id = await unit.counters.next('SLA');
  const policy = { _id: id, id, ...fields };
  await unit.policies.insert(policy);
  return policy;
}

export async function deleteCatalogItem(unit, actor, name, id) {
  role(actor, 'ADMINISTRATOR');
  // Take the same document-level write conflict as reporters establishing a reference.
  const locked = await unit[name].update({ _id: id }, { $inc: { referenceRevision: 1 } });
  requireThat(locked.matchedCount, 'Record could not be found.', 404);
  const inUse =
    name === 'services'
      ? await unit.incidents.one({ service: id })
      : (await unit.incidents.one({ category: id })) ||
        (await unit.services.one({ defaultCategory: id }));
  requireThat(
    !inUse,
    name === 'services'
      ? 'Service has incidents and cannot be deleted.'
      : 'Category is in use by incidents or services and cannot be deleted.',
    409,
  );
  await unit[name].delete({ _id: id });
}

export async function configure(unit, actor, input) {
  role(actor, 'ADMINISTRATOR');
  return unit.settingsRepository.findAndUpdate(
    { _id: 'global' },
    {
      $set: {
        assignmentStrategyKey: choice(input.assignmentStrategyKey, strategies, 'assignment strategy'),
        priorityStrategyKey: choice(input.priorityStrategyKey, priorityStrategies, 'priority strategy'),
        escalationStepMinutes: integer(input.escalationStepMinutes, 'Escalation step', 1, 1440),
        slaWarningFraction: integer(input.warnPercent, 'Warning threshold', 10, 99) / 100,
        ...(input.riskThresholdPercent === undefined
          ? {}
          : {
              riskThresholdPercent: integer(
                input.riskThresholdPercent,
                'Predictive risk threshold',
                10,
                99,
              ),
            }),
      },
    },
  );
}
