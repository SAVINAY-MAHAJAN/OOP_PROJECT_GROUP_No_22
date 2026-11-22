/** Domain values shared by the API and browser. */
export const levels = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const priorities = ['P1', 'P2', 'P3', 'P4'];
export const priorityLabel = { P1: 'Critical', P2: 'High', P3: 'Medium', P4: 'Low' };
export const roleLabel = {
  EMPLOYEE: 'Employee',
  TECHNICIAN: 'Technician',
  ADMINISTRATOR: 'Administrator',
};
export const roles = Object.keys(roleLabel);
export const strategies = ['SKILL', 'LOAD', 'ROUND_ROBIN', 'EXPERIENCE'];
export const priorityStrategies = ['WEIGHTED', 'RULES'];
export const openStates = [
  'NEW',
  'CLASSIFIED',
  'ASSIGNED',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'PENDING_INFO',
];
export const states = [...openStates, 'RESOLVED', 'VERIFIED', 'CLOSED', 'CANCELLED'];
export const slaStates = ['ON_TRACK', 'AT_RISK', 'BREACHED', 'MET', 'PAUSED', 'STOPPED'];
export const escalationChain = ['Technician', 'Team Lead', 'System Administrator', 'IT Manager'];
export const defaultTimeZone = 'Asia/Kolkata';
export const defaultCompanyDomain = 'nexora.com';
export const defaultRiskThreshold = 70;
