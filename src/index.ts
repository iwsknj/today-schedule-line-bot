import * as line from "@line/bot-sdk";
import { google } from "googleapis";
import { Hono } from "hono";
import GoogleAuth, { GoogleKey } from "cloudflare-workers-and-google-oauth";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import "dayjs/locale/ja";
dayjs.locale("ja");
dayjs.extend(utc);
dayjs.extend(timezone);

type Env = {
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  LINE_USER_ID: string;
  GCP_SERVICE_ACCOUNT: string;
  GOOGLE_CALENDER_ID: string;
};

const app = new Hono<{ Bindings: Env }>();

const main = async (env: Env) => {
  // カレンダーから予定を取得
  const scopes = ["https://www.googleapis.com/auth/calendar.readonly"];
  const googleAuth: GoogleKey = JSON.parse(env.GCP_SERVICE_ACCOUNT);
  const oauth = new GoogleAuth(googleAuth, scopes);
  const token = await oauth.getGoogleAuthToken();
  const calendar = google.calendar({ version: "v3" });
  const startOfDay = dayjs()
    .tz("Asia/Tokyo")
    .subtract(15, "day")
    .startOf("day")
    .hour(0)
    .minute(0)
    .second(0);
  const endOfDay = dayjs()
    .tz("Asia/Tokyo")
    .add(15, "day")
    .endOf("day")
    .hour(23)
    .minute(59)
    .second(59);
  const today = dayjs().tz("Asia/Tokyo");
  const yesterday = dayjs().tz("Asia/Tokyo").subtract(1, "day");
  const tomorrow = dayjs().tz("Asia/Tokyo").add(1, "day");
  const res = await calendar.events.list({
    calendarId: env.GOOGLE_CALENDER_ID,
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    oauth_token: token,
  });
  // 今日の終日予定を取得
  const dayEvents = res.data.items
    ?.filter((item) => {
      if (item.start?.date && item.end?.date) {
        const startDate = dayjs(item.start?.date);
        const endDate = dayjs(item.end?.date);
        if (startDate.isSame(today, "day")) {
          return true;
        }
        if (startDate.isBefore(today, "day") && endDate.isAfter(today, "day")) {
          return true;
        }
        if (
          startDate.isSame(yesterday, "day") &&
          endDate.isSame(today, "day")
        ) {
          return false;
        }
      }
    })
    .map((item) => {
      const startDate = dayjs(item.start?.date);
      const endDate = dayjs(item.end?.date);
      const isOneDayEvent =
        startDate.isSame(today, "day") && endDate.isSame(tomorrow, "day");
      return {
        title: item.summary,
        description: item.description,
        location: item.location,
        start: dayjs(item.start?.date),
        end: dayjs(item.end?.date),
        isOneDayEvent: isOneDayEvent,
      };
    });
  // 今日の時間予定を取得
  const dateEvents = res.data.items
    ?.filter((item) => {
      if (item.start?.dateTime && item.end?.dateTime) {
        const startDate = dayjs(item.start.dateTime);
        const endDate = dayjs(item.end.dateTime);
        if (startDate.isSame(today, "day")) {
          return true;
        }
        if (startDate.isBefore(today, "day") && endDate.isAfter(today, "day")) {
          return true;
        }
      }
    })
    .map((item) => {
      return {
        title: item.summary,
        description: item.description,
        location: item.location,
        start: dayjs(item.start?.dateTime),
        end: dayjs(item.end?.dateTime),
      };
    });
  // テキストメッセージを作成
  const textMessages = [
    "今日 " + dayjs().format("YYYY/MM/DD (ddd)") + "の予定",
    "",
    "--------------------------------------",
    "■終日予定",
    ...(dayEvents ?? []).map((event) => {
      let eventText = "";
      if (event.isOneDayEvent) {
        eventText = `${event.title}`;
      } else {
        eventText = `[${event.start.format("MM/DD (ddd)")} - ${event.end.format(
          "MM/DD (ddd)"
        )}] ${event.title}`;
      }
      return (
        eventText +
        (event.description ? `\n詳細: ${event.description}` : "") +
        (event.location ? `\n場所: ${event.location}` : "")
      );
    }),
    "--------------------------------------",
    "■時間予定",
    ...(dateEvents ?? []).map((event) => {
      return (
        `[${event.start.format("HH:mm")} - ${event.end.format("HH:mm")}]` +
        "\n" +
        event.title +
        (event.description ? `\n詳細: ${event.description}` : "") +
        (event.location ? `\n場所: ${event.location}` : "")
      );
    }),
    "--------------------------------------",
  ];
  // LINEへ送信
  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
  });
  line.middleware({
    channelSecret: env.LINE_CHANNEL_SECRET,
  });
  await client.pushMessage({
    to: env.LINE_USER_ID,
    messages: [{ type: "text", text: textMessages.join("\n") }],
  });
};

const scheduled: ExportedHandlerScheduledHandler<Env> = async (
  event,
  env,
  ctx
) => {
  ctx.waitUntil(main(env));
};

export default {
  fetch: app.fetch,
  scheduled,
};
