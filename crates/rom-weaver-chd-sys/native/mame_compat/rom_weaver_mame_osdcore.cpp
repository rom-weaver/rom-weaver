#include "osdcore.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

namespace {

thread_local int g_rw_mame_chd_thread_count = 1;

int rw_mame_resolved_thread_count() noexcept
{
    if (g_rw_mame_chd_thread_count < 1)
        return 1;
    if (g_rw_mame_chd_thread_count > WORK_MAX_THREADS)
        return WORK_MAX_THREADS;
    return g_rw_mame_chd_thread_count;
}

} // namespace

struct osd_work_item
{
    std::mutex mutex;
    std::condition_variable completed_cv;
    void *result = nullptr;
    bool complete = false;
    bool auto_release = false;
};

struct queued_work_item
{
    osd_work_callback callback = nullptr;
    void *param = nullptr;
    osd_work_item *item = nullptr;
};

struct osd_work_queue
{
    int flags = 0;
    std::atomic<int> pending{0};
    bool stopping = false;
    std::mutex mutex;
    std::condition_variable work_cv;
    std::condition_variable idle_cv;
    std::deque<queued_work_item> queued;
    std::vector<std::thread> workers;
};

static void rw_mame_complete_item(osd_work_queue *queue, queued_work_item &work, void *result)
{
    {
        std::lock_guard<std::mutex> guard(work.item->mutex);
        work.item->result = result;
        work.item->complete = true;
    }
    work.item->completed_cv.notify_all();

    if (queue) {
        int remaining = queue->pending.fetch_sub(1, std::memory_order_acq_rel) - 1;
        if (remaining <= 0) {
            std::lock_guard<std::mutex> queue_guard(queue->mutex);
            queue->idle_cv.notify_all();
        }
    }
    if (work.item->auto_release) {
        delete work.item;
    }
}

static void rw_mame_worker_loop(osd_work_queue *queue, int threadid)
{
    for (;;) {
        queued_work_item work;
        {
            std::unique_lock<std::mutex> lock(queue->mutex);
            queue->work_cv.wait(lock, [&] { return queue->stopping || !queue->queued.empty(); });
            if (queue->stopping && queue->queued.empty())
                return;
            work = queue->queued.front();
            queue->queued.pop_front();
        }

        void *result = nullptr;
        if (work.callback)
            result = work.callback(work.param, threadid);
        rw_mame_complete_item(queue, work, result);
    }
}

extern "C" void rw_mame_chd_set_thread_count(int thread_count) noexcept
{
    if (thread_count < 1) {
        g_rw_mame_chd_thread_count = 1;
    } else if (thread_count > WORK_MAX_THREADS) {
        g_rw_mame_chd_thread_count = WORK_MAX_THREADS;
    } else {
        g_rw_mame_chd_thread_count = thread_count;
    }
}

osd_ticks_t osd_ticks() noexcept
{
    using namespace std::chrono;
    return static_cast<osd_ticks_t>(
        duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count()
    );
}

osd_ticks_t osd_ticks_per_second() noexcept
{
    return 1'000'000'000ULL;
}

void osd_sleep(osd_ticks_t duration) noexcept
{
    std::this_thread::sleep_for(std::chrono::nanoseconds(duration));
}

osd_work_queue *osd_work_queue_alloc(int flags)
{
    auto *queue = new osd_work_queue();
    queue->flags = flags;

    int worker_count = 0;
    if (flags & WORK_QUEUE_FLAG_MULTI) {
        worker_count = rw_mame_resolved_thread_count();
    } else if (flags & WORK_QUEUE_FLAG_IO) {
        worker_count = 1;
    }

    for (int index = 0; index < worker_count; ++index) {
        queue->workers.emplace_back(
            [queue, index] { rw_mame_worker_loop(queue, index); }
        );
    }
    return queue;
}

int osd_work_queue_items(osd_work_queue *queue)
{
    return queue ? queue->pending.load(std::memory_order_acquire) : 0;
}

bool osd_work_queue_wait(osd_work_queue *queue, osd_ticks_t timeout)
{
    if (!queue)
        return true;

    std::unique_lock<std::mutex> lock(queue->mutex);
    if (timeout == 0) {
        return queue->pending.load(std::memory_order_acquire) == 0;
    }
    auto deadline = std::chrono::steady_clock::now() + std::chrono::nanoseconds(timeout);
    while (queue->pending.load(std::memory_order_acquire) != 0) {
        if (queue->idle_cv.wait_until(lock, deadline) == std::cv_status::timeout) {
            return queue->pending.load(std::memory_order_acquire) == 0;
        }
    }
    return true;
}

void osd_work_queue_free(osd_work_queue *queue)
{
    if (!queue)
        return;

    {
        std::lock_guard<std::mutex> guard(queue->mutex);
        queue->stopping = true;
    }
    queue->work_cv.notify_all();
    for (auto &worker : queue->workers) {
        if (worker.joinable())
            worker.join();
    }
    delete queue;
}

osd_work_item *osd_work_item_queue_multiple(
    osd_work_queue *queue,
    osd_work_callback callback,
    int32_t numitems,
    void *parambase,
    int32_t paramstep,
    uint32_t flags
)
{
    if (numitems <= 0 || callback == nullptr)
        return nullptr;

    osd_work_item *last = nullptr;
    auto *param = static_cast<unsigned char *>(parambase);
    bool const auto_release = (flags & WORK_ITEM_FLAG_AUTO_RELEASE) != 0;

    for (int32_t index = 0; index < numitems; ++index) {
        auto *item = new osd_work_item();
        item->auto_release = auto_release;
        queued_work_item work{callback, param, item};
        if (queue) {
            queue->pending.fetch_add(1, std::memory_order_acq_rel);
            if (!queue->workers.empty()) {
                {
                    std::lock_guard<std::mutex> lock(queue->mutex);
                    queue->queued.push_back(work);
                }
                queue->work_cv.notify_one();
            } else {
                void *result = callback(param, 0);
                rw_mame_complete_item(queue, work, result);
            }
        } else {
            void *result = callback(param, 0);
            rw_mame_complete_item(nullptr, work, result);
        }

        param += paramstep;
        if (auto_release) {
            last = nullptr;
        } else {
            last = item;
        }
    }
    return last;
}

bool osd_work_item_wait(osd_work_item *item, osd_ticks_t timeout)
{
    if (!item)
        return true;

    std::unique_lock<std::mutex> lock(item->mutex);
    if (timeout == 0) {
        return item->complete;
    }
    if (item->complete) {
        return true;
    }
    auto deadline = std::chrono::steady_clock::now() + std::chrono::nanoseconds(timeout);
    while (!item->complete) {
        if (item->completed_cv.wait_until(lock, deadline) == std::cv_status::timeout) {
            return item->complete;
        }
    }
    return true;
}

void *osd_work_item_result(osd_work_item *item)
{
    if (!item)
        return nullptr;
    std::lock_guard<std::mutex> guard(item->mutex);
    return item->result;
}

void osd_work_item_release(osd_work_item *item)
{
    if (!item)
        return;
    std::unique_lock<std::mutex> lock(item->mutex);
    while (!item->complete) {
        item->completed_cv.wait(lock);
    }
    lock.unlock();
    delete item;
}
