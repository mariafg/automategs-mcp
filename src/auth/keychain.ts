import keytar from 'keytar';

const SERVICE = 'automategs';

export async function storeSecret(key: string, value: string): Promise<void> {
  await keytar.setPassword(SERVICE, key, value);
}

export async function getSecret(key: string): Promise<string | null> {
  return keytar.getPassword(SERVICE, key);
}

export async function deleteSecret(key: string): Promise<void> {
  await keytar.deletePassword(SERVICE, key);
}
