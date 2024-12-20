import * as line from "@line/bot-sdk";
import { google } from "googleapis";
import type { calendar_v3 } from "googleapis/build/src/apis/calendar";
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
    timeMin: startOfDay.format(),
    timeMax: endOfDay.format(),
    singleEvents: true,
    orderBy: "startTime",
    oauth_token: token,
  });

  // 今日の終日予定を取得
  const dayEvents = res.data.items
    ?.filter((item) => {
      if (item.start?.date && item.end?.date) {
        const startDate = dayjs(item.start.date).tz("Asia/Tokyo");
        const endDate = dayjs(item.end.date).tz("Asia/Tokyo");
        return (
          startDate.isSame(today, "day") ||
          (startDate.isBefore(today, "day") &&
            endDate.isAfter(today, "day") &&
            !(
              startDate.isSame(yesterday, "day") && endDate.isSame(today, "day")
            ))
        );
      }
    })
    .map((item) => {
      const startDate = dayjs(item.start?.date).tz("Asia/Tokyo");
      const endDate = dayjs(item.end?.date).tz("Asia/Tokyo");
      const isOneDayEvent =
        startDate.isSame(today, "day") && endDate.isSame(tomorrow, "day");
      return {
        title: item.summary,
        description: item.description,
        location: item.location,
        start: startDate.format("MM/DD (ddd)"),
        end: endDate.format("MM/DD (ddd)"),
        isOneDayEvent: isOneDayEvent,
      };
    });

  // 今日の時間予定を取得
  const dateEvents = res.data.items
    ?.filter((item) => {
      if (item.start?.dateTime && item.end?.dateTime) {
        const startDate = dayjs(item.start.dateTime);
        const endDate = dayjs(item.end.dateTime);
        return (
          startDate.isSame(today, "day") ||
          (startDate.isBefore(today, "day") && endDate.isAfter(today, "day")) ||
          (startDate.isBefore(today, "day") && endDate.isSame(today, "day")) ||
          (startDate.isSame(today, "day") && endDate.isAfter(today, "day"))
        );
      }
    })
    .map((item) => {
      const startDate = dayjs(item.start?.dateTime).tz("Asia/Tokyo");
      const endDate = dayjs(item.end?.dateTime).tz("Asia/Tokyo");
      const isCrossingDay =
        !startDate.isSame(today, "day") || !endDate.isSame(today, "day");
      return {
        title: item.summary,
        description: item.description,
        location: item.location,
        start: startDate.format("HH:mm"),
        end: endDate.format("HH:mm"),
        startDate: startDate.format("MM/DD (ddd)"),
        endDate: endDate.format("MM/DD (ddd)"),
        isCrossingDay: isCrossingDay,
      };
    });

  // テキストメッセージを作成
  const textMessages = [
    "今日 " + today.format("YYYY/MM/DD (ddd)") + "の予定",
    "",
    "--------------------------------------",
    "■終日予定",
    ...(dayEvents ?? []).map((event, index) => {
      let eventText = "";
      if (event.isOneDayEvent) {
        eventText = `${event.title}`;
      } else {
        eventText = `[${event.start} - ${event.end}]\n${event.title}`;
      }
      return (
        (index + 1).toString() +
        ". " +
        eventText +
        (event.description ? `\n詳細: ${event.description}` : "") +
        (event.location ? `\n場所: ${event.location}` : "") +
        "\n"
      );
    }),
    "--------------------------------------",
    "■時間予定",
    ...(dateEvents ?? []).map((event, index) => {
      return (
        (index + 1).toString() +
        ". " +
        (event.isCrossingDay
          ? `[${event.startDate} ${event.start} - ${event.endDate} ${event.end}]`
          : `[${event.start} - ${event.end}]`) +
        "\n" +
        event.title +
        (event.description ? `\n詳細: ${event.description}` : "") +
        (event.location ? `\n場所: ${event.location}` : "") +
        "\n"
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
  _event,
  env,
  ctx
) => {
  ctx.waitUntil(main(env));
};

export default {
  fetch: app.fetch,
  scheduled,
};
