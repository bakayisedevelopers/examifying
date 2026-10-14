import { httpsCallable } from 'firebase/functions';
import { functions, isFirebaseConfigured } from '../firebase/config';

const call = async (name, payload = {}) => {
  if (!isFirebaseConfigured || !functions) throw new Error('Family account services are not available right now.');
  const response = await httpsCallable(functions, name)(payload);
  return response.data;
};

export const saveParentFamilyCheckoutDraft = (payload) => call('saveParentFamilyCheckoutDraft', payload);
export const getParentFamilyCheckoutDraft = (payload) => call('getParentFamilyCheckoutDraft', payload);
export const attachStudentsToParentFamilyCheckoutDraft = (payload) => call('attachStudentsToParentFamilyCheckoutDraft', payload);
export const previewParentFamilyDiscount = (payload) => call('previewParentFamilyDiscount', payload);
export const createManagedStudentInvite = (studentId) => call('createManagedStudentInvite', { studentId });
export const redeemManagedStudentInvite = (payload) => call('redeemManagedStudentInvite', payload);
