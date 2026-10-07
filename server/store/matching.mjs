// Which stored account a reported summary refers to, on the same marketplace:
// the same Amazon customer ID, or else the same email on an account whose
// customer ID isn't known yet (Amazon shows only the email while it wants the
// password again; the ID arrives once the account is signed in).
export function findAccountMatch(accounts, { marketplace, domain, customerId, email }) {
  const sameMarketplace = accounts.filter((account) => account.marketplace === marketplace && account.domain === domain);
  if (customerId) {
    const byId = sameMarketplace.find((account) => account.customerId === customerId);
    if (byId) return byId;
  }
  if (email) {
    return sameMarketplace.find((account) => account.email === email && (!account.customerId || !customerId || account.customerId === customerId)) ?? null;
  }
  return null;
}
