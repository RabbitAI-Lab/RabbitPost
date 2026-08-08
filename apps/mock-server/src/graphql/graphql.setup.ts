import { createSchema, createYoga } from 'graphql-yoga';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/use/ws';

export const GRAPHQL_PATH = '/graphql';

const users = [
  { id: '1', name: 'Alice', email: 'alice@example.com' },
  { id: '2', name: 'Bob', email: 'bob@example.com' },
];

export const schema = createSchema({
  typeDefs: /* GraphQL */ `
    type User {
      id: ID!
      name: String!
      email: String!
    }

    type Query {
      hello(name: String): String!
      user(id: ID!): User
    }

    type Mutation {
      echo(text: String!): String!
    }

    type Subscription {
      tick: Int!
    }
  `,
  resolvers: {
    Query: {
      hello: (_: unknown, args: { name?: string }) => `Hello, ${args.name || 'world'}!`,
      user: (_: unknown, args: { id: string }) =>
        users.find((u) => u.id === args.id) || null,
    },
    Mutation: {
      echo: (_: unknown, args: { text: string }) => args.text,
    },
    Subscription: {
      tick: {
        // 每 1s 自增推送
        subscribe: async function* () {
          let i = 0;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            i += 1;
            yield { tick: i };
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        },
      },
    },
  },
});

/**
 * graphql-yoga v5，作为 Express middleware 挂在 /graphql。
 * 注意：必须在 express.json() 之前挂载（yoga 自行读取 body 流）。
 */
export function createGraphqlYoga() {
  return createYoga({
    schema,
    graphqlEndpoint: GRAPHQL_PATH,
    logging: false,
  });
}

/**
 * GraphQL Subscription（graphql-transport-ws 子协议），
 * 挂在同一 HTTP server 的 /graphql 路径上（noServer + 手动 upgrade 分发）。
 */
export function createGraphqlWsServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  useServer({ schema }, wss);
  return wss;
}
