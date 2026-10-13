export const getPaystackCustomerDetails = ({ profile = {}, authName = '', authPhone = '' } = {}) => {
  const fullName = String(profile.displayName || profile.name || profile.fullName || authName || '')
    .trim()
    .replace(/\s+/g, ' ');
  const [firstName = '', ...lastNameParts] = fullName.split(' ');
  const lastName = lastNameParts.join(' ');
  const phone = String(profile.whatsappNumber || profile.phoneNumber || profile.phone || authPhone || '').trim();

  return {
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(phone ? { phone } : {}),
    ...(fullName ? { fullName } : {}),
  };
};
