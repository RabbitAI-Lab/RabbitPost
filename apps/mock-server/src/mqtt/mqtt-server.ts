import type { Aedes } from 'aedes';
import * as net from 'net';

export interface MqttHandle {
  broker: Aedes;
  server: net.Server;
}

/**
 * 进程内 MQTT broker（aedes，TCP，无认证）。
 * aedes v1 是纯 ESM，这里在函数内 lazy require（Node >= 22.12 支持 require ESM），
 * 避免 jest (CJS) 在未启用 MQTT 的测试中也去加载它。
 */
export async function startMqttBroker(port = 1883): Promise<MqttHandle> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Aedes } = require('aedes') as typeof import('aedes');
  const broker = await Aedes.createBroker();
  const server = net.createServer(broker.handle);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return { broker, server };
}

export async function stopMqttBroker(handle: MqttHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    handle.server.close(() => resolve());
  });
  await handle.broker.close();
}
