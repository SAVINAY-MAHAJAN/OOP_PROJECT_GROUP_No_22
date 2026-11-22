/** The three account types share identity and credentials, with role-specific visibility. */
export class User {
  constructor(document) {
    Object.assign(this, document);
    this.authVersion ??= 0;
  }

  /** The Mongo predicate for this actor's visible incidents. */
  incidentScope() {
    return { reporter: this.id };
  }

  /** Check ticket access after loading an individual document. */
  canSee(incident) {
    return incident.reporter === this.id;
  }

  /** Project fields safe to return to browsers. */
  publicProfile() {
    const { passwordHash, authVersion, googleSub, activeLoad, ...profile } = this;
    return profile;
  }

  /** Convert the account back into its persistence document. */
  toDocument() {
    return { ...this };
  }
}

/** An employee owns the incidents they report. */
export class Employee extends User {
  /** Validate employee profile fields. */
  static details(input) {
    return {
      department: text(input.department, 'Department', 0, 120),
      location: text(input.location, 'Location', 0, 120),
    };
  }
}

/** A technician can see both their own reports and their assigned cases. */
export class Technician extends User {
  /** Validate skills and capacity for new or existing technicians. */
  static details(input) {
    return {
      skills: words(input.skills, 'skills'),
      experienceYears: integer(input.experienceYears ?? 1, 'Experience', 0, 80),
      maxConcurrent: integer(input.maxConcurrent ?? 5, 'Maximum concurrent incidents', 1, 10000),
      teamLead: boolean(input.teamLead ?? false, 'Team lead'),
      available: boolean(input.available ?? true, 'Availability'),
    };
  }

  /** Match cases reported or assigned to this technician. */
  incidentScope() {
    return { $or: [{ assignedTo: this.id }, { reporter: this.id }] };
  }

  /** Determine access from either relationship. */
  canSee(incident) {
    return incident.assignedTo === this.id || super.canSee(incident);
  }
}

/** Administrators oversee the full incident queue. */
export class Administrator extends User {
  /** Validate the administrator title used by escalation. */
  static details(input) {
    return { title: text(input.title || 'IT Manager', 'Title', 2, 90) };
  }

  /** Administrators can search the entire queue. */
  incidentScope() {
    return {};
  }

  /** Administrators can read individual incident records. */
  canSee() {
    return true;
  }
}

const userTypes = { EMPLOYEE: Employee, TECHNICIAN: Technician, ADMINISTRATOR: Administrator };

/** Factory for both newly created accounts and MongoDB documents from older releases. */
export class UserFactory {
  /** Build a role-specific account from validated identity and credentials. */
  static create(role, input) {
    const Type = userTypes[choice(role, roles, 'role')];
    return new Type({
      role,
      name: input.name,
      email: input.email,
      passwordHash: input.passwordHash,
      ...Type.details(input),
      ...(role === 'TECHNICIAN' ? { activeLoad: 0 } : {}),
    });
  }

  /** Reconstruct the appropriate subtype without altering stored fields. */
  static from(document) {
    if (!document) return null;
    const Type = Object.hasOwn(userTypes, document.role) ? userTypes[document.role] : null;
    if (!Type) throw new Error('An account has an unrecognized role.');
    return new Type(document);
  }
}
import { boolean, choice, integer, text, words } from '../validation.js';
import { roles } from '../../shared/constants.js';
