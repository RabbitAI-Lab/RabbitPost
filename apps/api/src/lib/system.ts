/**
 * 系统级配置：默认团队、系统用户等。
 * 用于内嵌 Runner 自动注册等场景。
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { teams, users } from "../db/schema";

/**
 * 获取默认团队 ID。
 * 策略：返回最早创建的团队；如无团队则抛出错误。
 */
export async function getDefaultTeamId(): Promise<string> {
  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .orderBy(teams.createdAt)
    .limit(1);

  if (!team) {
    throw new Error("No team found: please create a team before starting embedded runner");
  }
  return team.id;
}

/**
 * 获取系统用户 ID。
 * 策略：返回最早创建的用户；如无用户则抛出错误。
 * 内嵌 Runner 的 createdBy 字段需要关联一个用户。
 */
export async function getSystemUserId(): Promise<string> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .orderBy(users.createdAt)
    .limit(1);

  if (!user) {
    throw new Error("No user found: please create a user before starting embedded runner");
  }
  return user.id;
}

/**
 * 检查系统是否已初始化（有团队和用户）。
 */
export async function isSystemInitialized(): Promise<boolean> {
  try {
    await getDefaultTeamId();
    await getSystemUserId();
    return true;
  } catch {
    return false;
  }
}
